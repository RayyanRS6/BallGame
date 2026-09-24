import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  PHASE_LOBBY,
  PHASE_MATCH_END,
  TEAM_BLUE,
  TEAM_NAMES,
  TEAM_RED,
  TEAM_SPECTATOR,
  type PlayingTeam,
  type TeamId,
} from '../../shared/constants/game.ts';
import { getPhysicsPreset, PHYSICS_PRESETS, sanitizePhysicsConfig, type PhysicsConfig } from '../../shared/constants/physics-config.ts';
import type { ErrorCode, RoomInfo, RoomSettingsInput, ServerControl } from '../../shared/protocol/control.ts';
import { encodeSnapshot, encodeSnapshotBody, MSG_REPLAY, type InputPacket } from '../../shared/protocol/messages.ts';
import { BotBrain } from '../../shared/simulation/ai.ts';
import { getMap } from '../../shared/simulation/maps.ts';
import { encodeReplay, ReplayRecorder } from '../../shared/simulation/replay.ts';
import { mixSeed } from '../../shared/simulation/rng.ts';
import { DEFAULT_MATCH_SETTINGS, sanitizeMatchSettings } from '../../shared/simulation/settings.ts';
import { GameSimulation, type SimEvent } from '../../shared/simulation/simulation.ts';
import type { InputState, RoomListing, RoomSettings, RosterEntry } from '../../shared/types/index.ts';
import type { ServerConfig } from '../config.ts';
import { InputBuffer } from '../match/input-buffer.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import { InputRateMonitor } from '../security/abuse.ts';

/** What a room needs from a network connection. */
export interface RoomClient {
  readonly ip: string;
  readonly bufferedAmount: number;
  sendControl(msg: ServerControl): void;
  sendBinary(data: Uint8Array): void;
  /** Reports a protocol violation detected by the room. */
  flag(kind: 'input_flood' | 'input_sequence' | 'invalid_state_transition'): void;
  /** Called when the room removes this client (kick, room closed). */
  detachFromRoom(reason: string): void;
}

export interface Member {
  id: number;
  name: string;
  avatar: string;
  team: TeamId;
  isBot: boolean;
  client: RoomClient | null;
  token: string;
  input: InputBuffer;
  inputRate: InputRateMonitor | null;
  brain: BotBrain | null;
  status: 'connected' | 'reconnecting' | 'ai';
  disconnectedAt: number;
  joinedAt: number;
  snapshotSeq: number;
  ping: number;
  ip: string;
}

export interface RoomDeps {
  config: ServerConfig;
  logger: Logger;
  metrics: Metrics;
  now: () => number;
}

export interface RoomOptions {
  persistent?: boolean;
  autoStart?: boolean;
  seed?: number;
}

const NEUTRAL: InputState = { x: 0, y: 0, kick: false };
const MAX_REPLAY_BYTES = 8 << 20;
const AUTO_START_DELAY_MS = 3000;
const ROSTER_REFRESH_MS = 2000;
const STATS_REFRESH_MS = 5000;
const SLOW_CLIENT_BYTES = 256 * 1024;
/** If the process stalls longer than this, skip ticks instead of fast-forwarding. */
const MAX_CATCH_UP_MS = 250;

function hashPassword(pw: string): Buffer {
  return createHash('sha256').update(pw, 'utf8').digest();
}

export function defaultRoomSettings(cfg: ServerConfig): RoomSettings {
  return {
    name: 'Room',
    isPublic: true,
    hasPassword: false,
    maxPlayers: Math.min(12, cfg.maxPlayersPerRoom),
    allowSpectators: true,
    allowTeamSwitchDuringMatch: false,
    aiTakeover: false,
    physicsPreset: 'classic',
    tickRate: cfg.tickRate,
    snapshotRate: cfg.snapshotRate,
    botDifficulty: 'normal',
    match: { ...DEFAULT_MATCH_SETTINGS },
  };
}

/**
 * One game room: owns the authoritative simulation, the members, the input
 * buffers, replay recording and all broadcast traffic.
 */
export class Room {
  readonly code: string;
  settings: RoomSettings;
  physics: PhysicsConfig;
  configVersion = 1;
  readonly persistent: boolean;
  readonly autoStart: boolean;
  sim!: GameSimulation;
  members = new Map<number, Member>();
  hostId = 0;
  destroyed = false;
  lastReplay: Uint8Array | null = null;
  emptySince: number;

  private passwordHash: Buffer | null = null;
  private customPhysics: Partial<PhysicsConfig> | null = null;
  private deps: RoomDeps;
  private seed: number;
  private epoch = 0;
  private nextTickAt = 0;
  private tickMs = 1000 / 60;
  private snapshotDivisor = 1;
  private recorder: ReplayRecorder | null = null;
  private bannedIps = new Set<string>();
  private autoStartAt = 0;
  private rosterDirty = true;
  private lastRosterAt = 0;
  private lastStatsAt = 0;
  private matchCounter = 0;

  constructor(code: string, input: RoomSettingsInput, deps: RoomDeps, opts: RoomOptions = {}) {
    this.code = code;
    this.deps = deps;
    this.persistent = opts.persistent ?? false;
    this.autoStart = opts.autoStart ?? false;
    this.seed = opts.seed ?? mixSeed(Date.now(), code.charCodeAt(0), Math.floor(Math.random() * 1e9));
    this.settings = defaultRoomSettings(deps.config);
    this.physics = getPhysicsPreset('classic').config;
    this.emptySince = deps.now();
    this.applySettingsInput(input, true);
    this.rebuildSimulation();
  }

  // ------------------------------------------------------------------ settings

  private applySettingsInput(input: RoomSettingsInput, initial: boolean): void {
    const cfg = this.deps.config;
    const base = this.settings;
    const match = sanitizeMatchSettings({ ...base.match, ...(input.match ?? {}) }, base.match);
    const tickRate = input.tickRate ?? base.tickRate;
    let preset = base.physicsPreset;
    if (input.physicsPreset !== undefined && (input.physicsPreset === 'custom' || PHYSICS_PRESETS.some((p) => p.id === input.physicsPreset))) {
      preset = input.physicsPreset;
    }
    if (input.customPhysics !== undefined) this.customPhysics = input.customPhysics;
    if (input.password !== undefined) this.passwordHash = input.password ? hashPassword(input.password) : null;
    if (initial && input.password === undefined && cfg.roomPassword && this.persistent) this.passwordHash = hashPassword(cfg.roomPassword);

    this.settings = {
      name: input.name ? input.name : base.name,
      isPublic: input.isPublic ?? base.isPublic,
      hasPassword: this.passwordHash !== null,
      maxPlayers: Math.min(cfg.maxPlayersPerRoom, input.maxPlayers ?? base.maxPlayers),
      allowSpectators: input.allowSpectators ?? base.allowSpectators,
      allowTeamSwitchDuringMatch: input.allowTeamSwitchDuringMatch ?? base.allowTeamSwitchDuringMatch,
      aiTakeover: input.aiTakeover ?? base.aiTakeover,
      physicsPreset: preset,
      tickRate,
      snapshotRate: Math.min(tickRate, cfg.snapshotRate),
      botDifficulty: input.botDifficulty ?? base.botDifficulty,
      match,
    };
    const presetCfg = getPhysicsPreset(preset === 'custom' ? 'classic' : preset).config;
    this.physics = preset === 'custom' && this.customPhysics ? sanitizePhysicsConfig(this.customPhysics, presetCfg) : presetCfg;
  }

  private rebuildSimulation(): void {
    const s = this.settings;
    const prev = this.sim;
    this.sim = new GameSimulation({ map: getMap(s.match.mapId), physics: this.physics, settings: s.match, tickRate: s.tickRate, seed: this.seed });
    if (prev) {
      for (const m of this.sortedMembers()) if (m.team !== TEAM_SPECTATOR) this.sim.addPlayer(m.id, m.team);
    }
    this.tickMs = 1000 / s.tickRate;
    this.snapshotDivisor = Math.max(1, Math.round(s.tickRate / s.snapshotRate));
    this.epoch = this.deps.now();
    this.nextTickAt = this.epoch;
    for (const m of this.members.values()) m.inputRate = m.isBot ? null : new InputRateMonitor(s.tickRate, this.deps.now());
  }

  info(): RoomInfo {
    return { code: this.code, settings: { ...this.settings }, physics: { ...this.physics }, configVersion: this.configVersion };
  }

  listing(region: string): RoomListing {
    return {
      code: this.code,
      name: this.settings.name,
      region,
      players: this.members.size,
      maxPlayers: this.settings.maxPlayers,
      mode: this.settings.match.mode,
      mapId: this.settings.match.mapId,
      hasPassword: this.settings.hasPassword,
      status: this.sim.match.phase === PHASE_LOBBY ? 'lobby' : 'playing',
      teamSize: this.settings.match.teamSize,
    };
  }

  // ------------------------------------------------------------------ membership

  get humanCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (!m.isBot && m.status !== 'ai') n++;
    return n;
  }

  sortedMembers(): Member[] {
    return [...this.members.values()].sort((a, b) => a.id - b.id);
  }

  private teamSize(team: PlayingTeam): number {
    let n = 0;
    for (const m of this.members.values()) if (m.team === team) n++;
    return n;
  }

  private allocateId(): number {
    for (let id = 1; id <= 255; id++) if (!this.members.has(id)) return id;
    return 0;
  }

  get matchActive(): boolean {
    const phase = this.sim.match.phase;
    return phase !== PHASE_LOBBY && phase !== PHASE_MATCH_END;
  }

  checkPassword(password: string): boolean {
    if (!this.passwordHash) return true;
    return timingSafeEqual(this.passwordHash, hashPassword(password));
  }

  /** Validates a join attempt. */
  canJoin(password: string, ip: string): ErrorCode | null {
    if (this.destroyed) return 'room_not_found';
    if (this.bannedIps.has(ip)) return 'banned';
    if (!this.checkPassword(password)) return 'bad_password';
    if (this.members.size >= this.settings.maxPlayers) return 'room_full';
    const size = this.settings.match.teamSize;
    const teamsFull = this.teamSize(TEAM_RED) >= size && this.teamSize(TEAM_BLUE) >= size;
    if (!this.settings.allowSpectators && teamsFull) return 'room_full';
    return null;
  }

  addHuman(client: RoomClient, name: string, avatar: string): Member {
    const now = this.deps.now();
    const id = this.allocateId();
    const member: Member = {
      id,
      name,
      avatar,
      team: TEAM_SPECTATOR,
      isBot: false,
      client,
      token: randomBytes(16).toString('hex'),
      input: new InputBuffer(),
      inputRate: new InputRateMonitor(this.settings.tickRate, now),
      brain: null,
      status: 'connected',
      disconnectedAt: 0,
      joinedAt: now,
      snapshotSeq: 0,
      ping: 0,
      ip: client.ip,
    };
    this.members.set(id, member);
    if (!this.hostId && !this.autoStart) this.hostId = id;
    this.emptySince = 0;

    // Auto-balance (public drop-in rooms) or fill an empty slot in the lobby.
    const size = this.settings.match.teamSize;
    const red = this.teamSize(TEAM_RED);
    const blue = this.teamSize(TEAM_BLUE);
    const canEnter = !this.matchActive || this.settings.allowTeamSwitchDuringMatch;
    if (canEnter && (this.autoStart || !this.settings.allowSpectators)) {
      const team = red <= blue ? TEAM_RED : TEAM_BLUE;
      if ((team === TEAM_RED ? red : blue) < size) this.assignTeam(member, team);
    }

    client.sendControl({ t: 'joined', code: this.code, playerId: id, token: member.token, room: this.info(), rejoined: false });
    this.systemChat(`${name} joined`);
    this.deps.logger.info('player_connected', { room: this.code, id, name, ip: client.ip });
    this.rosterDirty = true;
    return member;
  }

  addBot(team: PlayingTeam): Member | ErrorCode {
    if (this.members.size >= this.settings.maxPlayers) return 'room_full';
    if (this.teamSize(team) >= this.settings.match.teamSize) return 'team_full';
    const id = this.allocateId();
    const botNames = ['Atlas', 'Bolt', 'Comet', 'Dash', 'Echo', 'Flux', 'Gale', 'Hex', 'Ion', 'Jet', 'Kite', 'Lux'];
    const member: Member = {
      id,
      name: `${botNames[id % botNames.length]} (bot)`,
      avatar: 'AI',
      team: TEAM_SPECTATOR,
      isBot: true,
      client: null,
      token: '',
      input: new InputBuffer(),
      inputRate: null,
      brain: new BotBrain(id, this.settings.botDifficulty, this.seed + id),
      status: 'connected',
      disconnectedAt: 0,
      joinedAt: this.deps.now(),
      snapshotSeq: 0,
      ping: 0,
      ip: '',
    };
    this.members.set(id, member);
    this.assignTeam(member, team);
    this.rosterDirty = true;
    return member;
  }

  /** Applies a team change to the member and the simulation (recorded for replays). */
  private assignTeam(member: Member, team: TeamId): void {
    if (member.team === team) return;
    member.team = team;
    member.input.reset();
    this.sim.setPlayerTeam(member.id, team);
    this.recorder?.recordRoster(this.sim.tick, member.id, team);
    if (team !== TEAM_SPECTATOR) this.recorder?.describePlayer({ id: member.id, name: member.name, avatar: member.avatar, team });
    this.rosterDirty = true;
  }

  removeMember(id: number, reason: string): void {
    const m = this.members.get(id);
    if (!m) return;
    if (m.team !== TEAM_SPECTATOR) {
      this.sim.removePlayer(id);
      this.recorder?.recordRoster(this.sim.tick, id, TEAM_SPECTATOR);
    }
    this.members.delete(id);
    if (!m.isBot) {
      this.systemChat(`${m.name} left`);
      this.deps.logger.info('player_disconnected', { room: this.code, id, name: m.name, reason });
    }
    if (this.hostId === id) this.pickNewHost();
    if (this.humanCount === 0) {
      this.emptySince = this.deps.now();
      if (this.persistent) this.resetIdle();
    }
    if (this.autoStart && this.matchActive && (this.teamSize(TEAM_RED) === 0 || this.teamSize(TEAM_BLUE) === 0)) this.stopMatch('team empty');
    this.rosterDirty = true;
  }

  private resetIdle(): void {
    for (const m of [...this.members.values()]) if (m.isBot) this.removeMember(m.id, 'idle');
    this.stopMatch('idle');
  }

  private pickNewHost(): void {
    this.hostId = 0;
    if (this.autoStart) return;
    let best: Member | null = null;
    for (const m of this.members.values()) {
      if (m.isBot || m.status !== 'connected') continue;
      if (!best || m.joinedAt < best.joinedAt) best = m;
    }
    if (best) {
      this.hostId = best.id;
      this.systemChat(`${best.name} is now the host`);
    }
  }

  /** Connection dropped: keep the slot for the reconnection window. */
  handleDisconnect(member: Member): void {
    if (member.client === null) return;
    member.client = null;
    if (this.deps.config.reconnectWindowMs <= 0) {
      this.removeMember(member.id, 'disconnected');
      return;
    }
    member.status = 'reconnecting';
    member.disconnectedAt = this.deps.now();
    member.input.reset();
    if (this.settings.aiTakeover && member.team !== TEAM_SPECTATOR) {
      member.brain = new BotBrain(member.id, this.settings.botDifficulty, this.seed + member.id);
    }
    this.deps.logger.info('player_connection_lost', { room: this.code, id: member.id, name: member.name });
    this.systemChat(`${member.name} lost connection…`);
    if (this.hostId === member.id) this.pickNewHost();
    this.rosterDirty = true;
  }

  /** Restores identity, team and stats for a returning client. */
  rejoin(token: string, client: RoomClient): Member | null {
    for (const m of this.members.values()) {
      if (m.isBot || !m.token || m.token.length !== token.length) continue;
      if (!timingSafeEqual(Buffer.from(m.token), Buffer.from(token))) continue;
      if (m.status === 'connected' && m.client) m.client.detachFromRoom('replaced by a new connection');
      m.client = client;
      m.status = 'connected';
      m.brain = null;
      m.input.reset();
      m.ip = client.ip;
      if (!this.hostId && !this.autoStart) this.hostId = m.id;
      client.sendControl({ t: 'joined', code: this.code, playerId: m.id, token: m.token, room: this.info(), rejoined: true });
      this.deps.logger.info('player_reconnected', { room: this.code, id: m.id, name: m.name });
      this.systemChat(`${m.name} reconnected`);
      this.rosterDirty = true;
      this.emptySince = 0;
      return m;
    }
    return null;
  }

  // ------------------------------------------------------------------ requests

  private isHost(m: Member): boolean {
    return m.id === this.hostId;
  }

  requestTeam(requester: Member, team: TeamId, targetId?: number): ErrorCode | null {
    const target = targetId !== undefined ? this.members.get(targetId) : requester;
    if (!target) return 'bad_request';
    const host = this.isHost(requester);
    if (target !== requester && !host) return 'not_host';
    if (target.team === team) return null;
    if (!host && this.matchActive && !this.settings.allowTeamSwitchDuringMatch) {
      requester.client?.flag('invalid_state_transition');
      return 'team_locked';
    }
    if (team !== TEAM_SPECTATOR && this.teamSize(team) >= this.settings.match.teamSize) return 'team_full';
    this.assignTeam(target, team);
    if (target !== requester) this.systemChat(`${target.name} was moved to ${TEAM_NAMES[team]}`);
    return null;
  }

  updateSettings(requester: Member, input: RoomSettingsInput): ErrorCode | null {
    if (!this.isHost(requester)) return 'not_host';
    const structural =
      input.match !== undefined || input.physicsPreset !== undefined || input.customPhysics !== undefined || input.tickRate !== undefined;
    if (structural && this.sim.match.phase !== PHASE_LOBBY) return 'team_locked';
    this.applySettingsInput(input, false);
    // Enforce the new team size.
    const size = this.settings.match.teamSize;
    for (const team of [TEAM_RED, TEAM_BLUE] as const) {
      const mates = this.sortedMembers().filter((m) => m.team === team);
      for (let i = size; i < mates.length; i++) this.assignTeam(mates[i]!, TEAM_SPECTATOR);
    }
    if (structural) this.rebuildSimulation();
    for (const m of this.members.values()) if (m.brain && m.isBot) m.brain.difficulty = this.settings.botDifficulty;
    this.configVersion++;
    this.broadcastControl({ t: 'room', room: this.info() });
    this.rosterDirty = true;
    this.deps.logger.info('room_settings_changed', { room: this.code, by: requester.id });
    return null;
  }

  requestStart(requester: Member): ErrorCode | null {
    if (!this.isHost(requester)) return 'not_host';
    if (this.sim.match.phase !== PHASE_LOBBY) return 'bad_request';
    this.startMatch();
    return null;
  }

  requestStop(requester: Member): ErrorCode | null {
    if (!this.isHost(requester)) return 'not_host';
    this.stopMatch('stopped by host');
    return null;
  }

  requestKick(requester: Member, targetId: number, ban: boolean): ErrorCode | null {
    if (!this.isHost(requester)) return 'not_host';
    const target = this.members.get(targetId);
    if (!target || target === requester) return 'bad_request';
    if (ban && target.ip) this.bannedIps.add(target.ip);
    const client = target.client;
    this.removeMember(targetId, ban ? 'banned' : 'kicked');
    client?.detachFromRoom(ban ? 'You were banned from the room' : 'You were kicked from the room');
    return null;
  }

  requestRemoveBot(requester: Member, id: number): ErrorCode | null {
    if (!this.isHost(requester)) return 'not_host';
    const target = this.members.get(id);
    if (!target || !target.isBot) return 'bad_request';
    this.removeMember(id, 'removed');
    return null;
  }

  requestAddBot(requester: Member, team: PlayingTeam): ErrorCode | null {
    if (!this.isHost(requester)) return 'not_host';
    const r = this.addBot(team);
    return typeof r === 'string' ? r : null;
  }

  updateProfile(member: Member, name: string, avatar: string): void {
    member.name = name;
    member.avatar = avatar;
    this.rosterDirty = true;
  }

  chat(member: Member, text: string): void {
    this.broadcastControl({ t: 'chat', from: member.id, name: member.name, text, system: false });
  }

  systemChat(text: string): void {
    this.broadcastControl({ t: 'chat', from: 0, name: '', text, system: true });
  }

  sendReplay(member: Member): ErrorCode | null {
    if (!this.lastReplay || !member.client) return 'no_replay';
    const out = new Uint8Array(1 + this.lastReplay.byteLength);
    out[0] = MSG_REPLAY;
    out.set(this.lastReplay, 1);
    member.client.sendBinary(out);
    return null;
  }

  // ------------------------------------------------------------------ inputs

  onInput(member: Member, packet: InputPacket): void {
    if (member.isBot || member.team === TEAM_SPECTATOR || member.status !== 'connected') return;
    const now = this.deps.now();
    const first = packet.newestSeq - packet.inputs.length + 1;
    let fresh = 0;
    for (let i = 0; i < packet.inputs.length; i++) {
      const r = member.input.push(first + i, packet.inputs[i]!);
      if (r === 'ok') fresh++;
      else if (r === 'invalid') {
        member.client?.flag('input_sequence');
        return;
      }
    }
    if (member.inputRate?.add(fresh, now)) member.client?.flag('input_flood');
  }

  // ------------------------------------------------------------------ match flow

  startMatch(): void {
    this.sim.startMatch();
    this.matchCounter++;
    this.recorder = new ReplayRecorder(this.sim, this.seed, `${this.settings.name} #${this.matchCounter}`);
    for (const m of this.members.values()) {
      if (m.team !== TEAM_SPECTATOR) this.recorder.describePlayer({ id: m.id, name: m.name, avatar: m.avatar, team: m.team });
    }
    this.autoStartAt = 0;
    this.deps.logger.info('match_started', { room: this.code, red: this.teamSize(TEAM_RED), blue: this.teamSize(TEAM_BLUE) });
  }

  stopMatch(reason: string): void {
    if (this.sim.match.phase === PHASE_LOBBY) return;
    this.finishRecording();
    this.sim.stopMatch();
    this.deps.logger.info('match_stopped', { room: this.code, reason });
  }

  private finishRecording(): void {
    if (!this.recorder) return;
    const data = this.recorder.finish(this.sim);
    this.recorder = null;
    if (data.endTick - data.startTick < this.settings.tickRate) return;
    const bytes = encodeReplay(data);
    if (bytes.byteLength <= MAX_REPLAY_BYTES) this.lastReplay = bytes;
  }

  private handleEvents(events: readonly SimEvent[]): void {
    const m = this.sim.match;
    for (const e of events) {
      switch (e.type) {
        case 'goal':
          if (e.practice) break;
          this.deps.metrics.goals++;
          this.deps.logger.info('goal_scored', { room: this.code, team: TEAM_NAMES[e.team], scorer: e.scorerId, ownGoal: e.ownGoal, score: `${m.scoreRed}-${m.scoreBlue}` });
          this.broadcastControl({ t: 'goal', team: e.team, scorerId: e.scorerId, assistId: e.assistId, ownGoal: e.ownGoal, scoreRed: m.scoreRed, scoreBlue: m.scoreBlue });
          this.broadcastStats();
          break;
        case 'matchEnd': {
          if (e.seriesOver) this.finishRecording();
          this.deps.metrics.matchesCompleted++;
          this.deps.logger.info('match_completed', { room: this.code, winner: TEAM_NAMES[e.winner], score: `${m.scoreRed}-${m.scoreBlue}`, seriesOver: e.seriesOver });
          this.broadcastControl({
            t: 'matchEnd',
            winner: e.winner,
            scoreRed: m.scoreRed,
            scoreBlue: m.scoreBlue,
            stats: this.sim.getStats(),
            seriesOver: e.seriesOver,
            replayAvailable: e.seriesOver && this.lastReplay !== null,
          });
          break;
        }
        case 'phase':
          if (e.phase === PHASE_LOBBY) this.finishRecording();
          break;
        case 'fault':
          this.deps.logger.warn('simulation_fault', { room: this.code, reason: e.reason, tick: this.sim.tick });
          break;
        default:
          break;
      }
    }
  }

  // ------------------------------------------------------------------ ticking

  get nextDue(): number {
    return this.nextTickAt;
  }

  /** Runs every tick that is due at `now`. */
  advance(now: number): void {
    if (this.destroyed) return;
    if (this.persistent && this.humanCount === 0 && this.members.size === 0) {
      // Idle persistent room: sleep, but keep the clock aligned.
      this.nextTickAt = now + this.tickMs;
      return;
    }
    if (now - this.nextTickAt > MAX_CATCH_UP_MS) {
      this.deps.logger.warn('tick_overrun', { room: this.code, behindMs: Math.round(now - this.nextTickAt) });
      const skipped = Math.floor((now - this.nextTickAt) / this.tickMs);
      this.nextTickAt += skipped * this.tickMs;
      this.epoch += skipped * this.tickMs; // keep serverTime = epoch + tick·dt consistent
    }
    while (now >= this.nextTickAt) {
      this.tick();
      this.nextTickAt += this.tickMs;
    }
    this.housekeeping(now);
  }

  /** One authoritative simulation tick. */
  tick(): void {
    const t0 = performance.now();
    const sim = this.sim;
    for (const p of sim.players) {
      const m = this.members.get(p.id);
      let input: InputState = NEUTRAL;
      if (m) {
        if (m.brain && (m.isBot || m.status !== 'connected')) input = m.brain.think(sim);
        else if (m.status === 'connected') input = m.input.consume();
      }
      sim.setInput(p.id, input.x, input.y, input.kick);
    }
    this.recorder?.recordInputs(sim);
    sim.step();
    this.handleEvents(sim.events);
    if (sim.tick % this.snapshotDivisor === 0) this.broadcastSnapshot();
    this.deps.metrics.recordTick(performance.now() - t0);
  }

  private housekeeping(now: number): void {
    // Reconnection window expiry.
    for (const m of [...this.members.values()]) {
      if (m.status !== 'reconnecting' || now - m.disconnectedAt < this.deps.config.reconnectWindowMs) continue;
      if (this.settings.aiTakeover && m.team !== TEAM_SPECTATOR) {
        m.status = 'ai';
        m.brain ??= new BotBrain(m.id, this.settings.botDifficulty, this.seed + m.id);
        m.name = `${m.name} (AI)`;
        m.token = '';
        this.rosterDirty = true;
      } else {
        this.removeMember(m.id, 'reconnect window expired');
      }
    }

    // Auto-start for drop-in public rooms.
    if (this.autoStart && this.sim.match.phase === PHASE_LOBBY) {
      const ready = this.teamSize(TEAM_RED) > 0 && this.teamSize(TEAM_BLUE) > 0;
      if (!ready) this.autoStartAt = 0;
      else if (!this.autoStartAt) {
        this.autoStartAt = now + AUTO_START_DELAY_MS;
        this.systemChat('Match starting in 3 seconds');
      } else if (now >= this.autoStartAt) this.startMatch();
    }

    if (this.rosterDirty || now - this.lastRosterAt > ROSTER_REFRESH_MS) {
      this.rosterDirty = false;
      this.lastRosterAt = now;
      this.broadcastControl({ t: 'roster', players: this.roster(), hostId: this.hostId });
    }
    if (this.matchActive && now - this.lastStatsAt > STATS_REFRESH_MS) {
      this.lastStatsAt = now;
      this.broadcastStats();
    }
  }

  roster(): RosterEntry[] {
    return this.sortedMembers().map((m) => ({
      id: m.id,
      name: m.name,
      avatar: m.avatar,
      team: m.team,
      isBot: m.isBot,
      isHost: m.id === this.hostId,
      ping: m.ping,
      status: m.status,
    }));
  }

  private broadcastStats(): void {
    this.broadcastControl({ t: 'stats', stats: this.sim.getStats() });
  }

  serverTimeOfTick(tick: number): number {
    return this.epoch + tick * this.tickMs;
  }

  private broadcastSnapshot(): void {
    const body = encodeSnapshotBody(this.sim.getState());
    const serverTime = this.serverTimeOfTick(this.sim.tick);
    for (const m of this.members.values()) {
      const c = m.client;
      if (!c || m.status !== 'connected') continue;
      if (c.bufferedAmount > SLOW_CLIENT_BYTES) continue; // slow consumer: skip, a newer snapshot supersedes it
      const packet = encodeSnapshot(
        { seq: ++m.snapshotSeq, ackSeq: m.input.lastProcessed, queueDepth: m.input.depth, configVersion: this.configVersion, serverTime },
        body,
      );
      c.sendBinary(packet);
    }
  }

  broadcastControl(msg: ServerControl): void {
    for (const m of this.members.values()) if (m.client && m.status === 'connected') m.client.sendControl(msg);
  }

  destroy(reason: string): void {
    if (this.destroyed) return;
    this.finishRecording();
    for (const m of this.members.values()) m.client?.detachFromRoom(reason);
    this.members.clear();
    this.destroyed = true;
  }
}
