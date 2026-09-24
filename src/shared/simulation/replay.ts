/**
 * Input-based replays. Because the simulation is deterministic, a replay only
 * stores the initial state, the configuration, roster changes and input
 * *changes* — the match is reproduced by re-simulating it.
 */
import { GAME_VERSION, PHYSICS_VERSION, TEAM_SPECTATOR, type TeamId } from '../constants/game.ts';
import { sanitizePhysicsConfig, type PhysicsConfig } from '../constants/physics-config.ts';
import { ByteReader, ByteWriter } from '../protocol/binary.ts';
import type { MatchSettings, MatchStats, SimStateData } from '../types/index.ts';
import { getMap } from './maps.ts';
import { sanitizeMatchSettings } from './settings.ts';
import { GameSimulation } from './simulation.ts';

export const REPLAY_FORMAT = 1;
const MAGIC = [0x4d, 0x46, 0x52]; // "MFR"

export interface ReplayPlayerInfo {
  id: number;
  name: string;
  avatar: string;
  team: TeamId;
}

export interface RosterOp {
  tick: number;
  id: number;
  team: TeamId;
}

export interface InputRecord {
  tick: number;
  id: number;
  x: number;
  y: number;
  kick: boolean;
}

export interface ReplayData {
  format: number;
  gameVersion: string;
  physicsVersion: number;
  mapId: string;
  mapVersion: number;
  seed: number;
  tickRate: number;
  settings: MatchSettings;
  physics: PhysicsConfig;
  players: ReplayPlayerInfo[];
  initialState: SimStateData;
  initialStats: MatchStats;
  startTick: number;
  endTick: number;
  roster: RosterOp[];
  inputs: InputRecord[];
  finalHash: number;
  recordedAt: number;
  title: string;
}

export class ReplayRecorder {
  private data: ReplayData;
  private last = new Map<number, { x: number; y: number; kick: boolean }>();
  private names = new Map<number, ReplayPlayerInfo>();
  active = true;

  constructor(sim: GameSimulation, seed: number, title: string) {
    const state = sim.getState();
    this.data = {
      format: REPLAY_FORMAT,
      gameVersion: GAME_VERSION,
      physicsVersion: PHYSICS_VERSION,
      mapId: sim.map.id,
      mapVersion: sim.map.version,
      seed,
      tickRate: sim.tickRate,
      settings: { ...sim.settings },
      physics: { ...sim.physics },
      players: [],
      initialState: state,
      initialStats: sim.getStats(),
      startTick: sim.tick,
      endTick: sim.tick,
      roster: [],
      inputs: [],
      finalHash: 0,
      recordedAt: Date.now(),
      title,
    };
    for (const p of state.players) this.last.set(p.id, { x: p.ix, y: p.iy, kick: p.kick });
  }

  /** Remembers display info for a participant (names are not part of the simulation). */
  describePlayer(info: ReplayPlayerInfo): void {
    this.names.set(info.id, { ...info });
  }

  /** Records a team change applied to the simulation before tick `tick` runs. */
  recordRoster(tick: number, id: number, team: TeamId): void {
    if (!this.active) return;
    this.data.roster.push({ tick, id, team });
    if (team === TEAM_SPECTATOR) this.last.delete(id);
    else if (!this.last.has(id)) this.last.set(id, { x: 0, y: 0, kick: false });
  }

  /** Call after inputs are applied and right before `sim.step()`. */
  recordInputs(sim: GameSimulation): void {
    if (!this.active) return;
    for (const p of sim.players) {
      const prev = this.last.get(p.id);
      if (prev && prev.x === p.ix && prev.y === p.iy && prev.kick === p.kick) continue;
      this.data.inputs.push({ tick: sim.tick, id: p.id, x: p.ix, y: p.iy, kick: p.kick });
      this.last.set(p.id, { x: p.ix, y: p.iy, kick: p.kick });
    }
  }

  finish(sim: GameSimulation): ReplayData {
    this.active = false;
    this.data.endTick = sim.tick;
    this.data.finalHash = sim.hash();
    this.data.players = [...this.names.values()].sort((a, b) => a.id - b.id);
    return this.data;
  }

  get durationTicks(): number {
    return this.data.endTick - this.data.startTick;
  }
}

// ------------------------------------------------------------------ binary format

export function encodeReplay(r: ReplayData): Uint8Array {
  const { inputs, ...header } = r;
  const w = new ByteWriter(4096 + inputs.length * 6);
  for (const b of MAGIC) w.u8(b);
  w.u8(REPLAY_FORMAT);
  w.string(JSON.stringify(header));
  w.varint(inputs.length);
  let prevTick = r.startTick;
  for (const rec of inputs) {
    w.varint(rec.tick - prevTick);
    prevTick = rec.tick;
    w.u8(rec.id).i8(rec.x).i8(rec.y).u8(rec.kick ? 1 : 0);
  }
  return w.finish();
}

export function decodeReplay(bytes: Uint8Array): ReplayData {
  const r = new ByteReader(bytes);
  for (const b of MAGIC) if (r.u8() !== b) throw new Error('Not a replay file');
  const format = r.u8();
  if (format !== REPLAY_FORMAT) throw new Error(`Unsupported replay format ${format}`);
  const header = JSON.parse(r.string(8 << 20)) as Omit<ReplayData, 'inputs'>;
  if (header.physicsVersion !== PHYSICS_VERSION) throw new Error('Replay was recorded with a different physics version');
  const count = r.varint();
  const inputs: InputRecord[] = [];
  let tick = header.startTick;
  for (let i = 0; i < count; i++) {
    tick += r.varint();
    inputs.push({ tick, id: r.u8(), x: r.i8(), y: r.i8(), kick: r.u8() === 1 });
  }
  return {
    ...header,
    settings: sanitizeMatchSettings(header.settings),
    physics: sanitizePhysicsConfig(header.physics),
    inputs,
  };
}

// ------------------------------------------------------------------ playback

interface Keyframe {
  tick: number;
  state: SimStateData;
  stats: MatchStats;
  inputIdx: number;
  rosterIdx: number;
}

/** Deterministic replay playback engine with keyframe-based seeking. */
export class ReplayPlayer {
  readonly sim: GameSimulation;
  readonly data: ReplayData;
  private inputIdx = 0;
  private rosterIdx = 0;
  private keyframes: Keyframe[] = [];

  constructor(data: ReplayData) {
    this.data = data;
    this.sim = new GameSimulation({
      map: getMap(data.mapId),
      physics: data.physics,
      settings: data.settings,
      tickRate: data.tickRate,
      seed: data.seed,
    });
    this.restart();
  }

  get tick(): number {
    return this.sim.tick;
  }

  get finished(): boolean {
    return this.sim.tick >= this.data.endTick;
  }

  restart(): void {
    this.sim.setState(this.data.initialState);
    this.sim.stats.restore(this.data.initialStats);
    this.inputIdx = 0;
    this.rosterIdx = 0;
  }

  /** Advances one tick. Returns false at the end of the replay. */
  step(): boolean {
    if (this.finished) return false;
    const sim = this.sim;
    const t = sim.tick;
    const roster = this.data.roster;
    while (this.rosterIdx < roster.length && roster[this.rosterIdx]!.tick <= t) {
      const op = roster[this.rosterIdx++]!;
      sim.setPlayerTeam(op.id, op.team);
    }
    const inputs = this.data.inputs;
    while (this.inputIdx < inputs.length && inputs[this.inputIdx]!.tick <= t) {
      const rec = inputs[this.inputIdx++]!;
      sim.setInput(rec.id, rec.x, rec.y, rec.kick);
    }
    sim.step();
    return true;
  }

  /** Simulates the whole replay once, storing keyframes for instant seeking. */
  buildKeyframes(intervalTicks = this.data.tickRate * 5): void {
    const prevEmit = this.sim.emitEvents;
    this.sim.emitEvents = false;
    this.restart();
    this.keyframes = [];
    do {
      if ((this.sim.tick - this.data.startTick) % intervalTicks === 0) {
        this.keyframes.push({ tick: this.sim.tick, state: this.sim.getState(), stats: this.sim.getStats(), inputIdx: this.inputIdx, rosterIdx: this.rosterIdx });
      }
    } while (this.step());
    this.restart();
    this.sim.emitEvents = prevEmit;
  }

  /** Jumps to `tick` (clamped). Events are suppressed while fast-forwarding. */
  seek(tick: number): void {
    const target = Math.max(this.data.startTick, Math.min(this.data.endTick, Math.floor(tick)));
    let kf: Keyframe | undefined;
    for (const k of this.keyframes) if (k.tick <= target) kf = k;
    if (kf && (target < this.sim.tick || kf.tick > this.sim.tick)) {
      this.sim.setState(kf.state);
      this.sim.stats.restore(kf.stats);
      this.inputIdx = kf.inputIdx;
      this.rosterIdx = kf.rosterIdx;
    } else if (target < this.sim.tick) {
      this.restart();
    }
    const prevEmit = this.sim.emitEvents;
    this.sim.emitEvents = false;
    while (this.sim.tick < target && this.step());
    this.sim.emitEvents = prevEmit;
  }

  playerInfo(id: number): ReplayPlayerInfo | undefined {
    return this.data.players.find((p) => p.id === id);
  }
}
