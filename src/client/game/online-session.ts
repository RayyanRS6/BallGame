import {
  INPUT_REDUNDANCY,
  PHASE_COUNTDOWN,
  PHASE_HALFTIME,
  PHASE_LOBBY,
  PHASE_PLAYING,
  TEAM_BLUE,
  TEAM_RED,
  TEAM_SPECTATOR,
  type TeamId,
} from '../../shared/constants/game.ts';
import type { RoomInfo, ServerControl } from '../../shared/protocol/control.ts';
import { encodeInputPacket, type DecodedSnapshot } from '../../shared/protocol/messages.ts';
import { getMap } from '../../shared/simulation/maps.ts';
import { decodeReplay } from '../../shared/simulation/replay.ts';
import { GameSimulation } from '../../shared/simulation/simulation.ts';
import type { MatchStats, RosterEntry } from '../../shared/types/index.ts';
import { input } from '../input/input-manager.ts';
import type { NetClient, NetState } from '../network/net-client.ts';
import { InterpolationBuffer } from '../prediction/interpolation.ts';
import { Predictor } from '../prediction/predictor.ts';
import { TimeDilation } from '../prediction/time-dilation.ts';
import { teamPalette } from '../rendering/colors.ts';
import { PlayerPool, type RenderFrame } from '../rendering/frame.ts';
import { storeReplay } from '../replays.ts';
import { settings } from '../settings.ts';
import { sessionSet } from '../storage.ts';
import { ChatBox } from '../ui/chat.ts';
import { downloadBlob } from '../ui/dom.ts';
import { matchSummary } from '../ui/match-summary.ts';
import { openModal, type ModalHandle } from '../ui/modal.ts';
import { RoomPanel } from '../ui/room-panel.ts';
import { toast } from '../ui/toast.ts';
import type { GameView } from './game-view.ts';
import { fmt, PrevPositions, RateCounter, Smoother, type GameSession } from './session.ts';

export interface OnlineCallbacks {
  exit(reason?: string): void;
}

export interface JoinedInfo {
  code: string;
  playerId: number;
  token: string;
  room: RoomInfo;
}

const NEUTRAL = { x: 0, y: 0, kick: false };
export const REJOIN_KEY = 'momentum.rejoin';
/** Client ticks simulated per frame at most (throttled tabs, stalls). */
const MAX_CATCHUP_TICKS = 20;

/**
 * Online play against an authoritative server.
 *
 *  - local player (and by default the ball): client-side prediction with
 *    server reconciliation, corrections smoothed visually;
 *  - remote players: snapshot interpolation (or prediction, configurable);
 *  - timer, score and match state: always the server's.
 */
export class OnlineSession implements GameSession {
  readonly kind = 'online';
  private net: NetClient;
  private cb: OnlineCallbacks;
  private view!: GameView;
  private room: RoomInfo;
  private code: string;
  private playerId: number;
  private roster: RosterEntry[] = [];
  private hostId = 0;
  private sim!: GameSimulation;
  private predictor!: Predictor;
  private interp = new InterpolationBuffer();
  private dilation = new TimeDilation();
  private prev = new PrevPositions();
  private smoother = new Smoother();
  private pool = new PlayerPool();
  private latest: DecodedSnapshot | null = null;
  private accum = 0;
  private tps = new RateCounter();
  private panel!: RoomPanel;
  private chat!: ChatBox;
  private modal: ModalHandle | null = null;
  private stats: MatchStats | null = null;
  private status: 'connected' | 'reconnecting' = 'connected';
  private lastCountdown = -1;
  private remoteLatch = new Map<number, boolean>();
  private pendingReplaySave = false;
  private before = new Map<number, { x: number; y: number }>();

  constructor(net: NetClient, joined: JoinedInfo, cb: OnlineCallbacks) {
    this.net = net;
    this.cb = cb;
    this.room = joined.room;
    this.code = joined.code;
    this.playerId = joined.playerId;
    net.setRejoin(joined.code, joined.token);
    sessionSet(REJOIN_KEY, JSON.stringify({ server: net.serverUrl, code: joined.code, token: joined.token }));
    net.handlers = {
      control: (m) => this.onControl(m),
      snapshot: (s, bytes) => this.onSnapshot(s, bytes),
      replay: (b) => this.onReplay(b),
      state: (s, reason) => this.onNetState(s, reason),
    };
    this.buildSim();
  }

  private buildSim(): void {
    const s = this.room.settings;
    this.sim = new GameSimulation({ map: getMap(s.match.mapId), physics: this.room.physics, settings: s.match, tickRate: s.tickRate, seed: 0 });
    this.predictor = new Predictor(this.sim);
    this.predictor.localId = this.playerId;
    this.interp.clear();
    this.latest = null;
    this.prev.clear();
    this.smoother.clear();
    this.dilation.reset();
    this.accum = 0;
  }

  attach(view: GameView): void {
    this.view = view;
    this.panel = new RoomPanel(view.overlay, {
      send: (m) => this.net.sendControl(m),
      leave: () => this.cb.exit(),
      shareLink: () => this.shareLink(),
      serverLabel: () => `${new URL(this.net.serverUrl).host} · ${Math.round(this.net.clock.srtt)} ms`,
    });
    this.chat = new ChatBox(view.overlay, (text) => this.net.sendControl({ t: 'chat', text }));
    this.chat.add('', `Joined room ${this.code}. Press Enter to chat, Esc for the room menu.`, true);
    this.refreshPanel();
  }

  private shareLink(): string {
    const u = new URL(location.origin + location.pathname);
    u.searchParams.set('room', this.code);
    if (this.net.serverUrl !== location.origin) u.searchParams.set('server', this.net.serverUrl);
    return u.toString();
  }

  private get phase(): number {
    return this.latest?.state.match.phase ?? PHASE_LOBBY;
  }

  private refreshPanel(): void {
    this.panel?.update(this.room, this.roster, this.hostId, this.playerId, this.phase);
  }

  private get myTeam(): TeamId {
    return this.roster.find((p) => p.id === this.playerId)?.team ?? TEAM_SPECTATOR;
  }

  private nameOf(id: number): string {
    return this.roster.find((p) => p.id === id)?.name ?? '';
  }

  // ------------------------------------------------------------------ network events

  private onControl(msg: ServerControl): void {
    switch (msg.t) {
      case 'joined':
        // Session restored after a reconnect: sequence numbers restart.
        this.playerId = msg.playerId;
        this.room = msg.room;
        this.net.setRejoin(msg.code, msg.token);
        this.buildSim();
        if (msg.rejoined) toast('Reconnected', 'success');
        this.refreshPanel();
        break;
      case 'room': {
        const rebuild = msg.room.configVersion !== this.room.configVersion;
        this.room = msg.room;
        if (rebuild) this.buildSim();
        this.refreshPanel();
        break;
      }
      case 'roster': {
        const prevTeam = this.myTeam;
        this.roster = msg.players;
        this.hostId = msg.hostId;
        if (prevTeam !== this.myTeam) {
          this.smoother.clear();
          this.prev.clear();
        }
        this.refreshPanel();
        break;
      }
      case 'chat': {
        const team = this.roster.find((p) => p.id === msg.from)?.team;
        this.chat?.add(msg.name, msg.text, msg.system, team === TEAM_RED || team === TEAM_BLUE ? teamPalette(team).fill : undefined);
        break;
      }
      case 'goal': {
        const W = this.sim.map.halfWidth;
        const scorer = this.nameOf(msg.scorerId);
        const assist = this.nameOf(msg.assistId);
        this.view.effects.goal(msg.team, msg.team === TEAM_RED ? W + 20 : -W - 20, this.sim.ball.y);
        const sub = scorer ? (msg.ownGoal ? `Own goal by ${scorer}` : `${scorer}${assist ? `  (assist ${assist})` : ''}`) : '';
        this.view.hud.banner('GOAL!', sub, teamPalette(msg.team).fill, 2000);
        this.chat.add('', `Goal ${msg.team === TEAM_RED ? 'Red' : 'Blue'}! ${sub}  (${msg.scoreRed}–${msg.scoreBlue})`, true);
        break;
      }
      case 'stats':
        this.stats = msg.stats;
        break;
      case 'matchEnd': {
        this.stats = msg.stats;
        const w = msg.winner === TEAM_RED ? 'Red wins' : msg.winner === TEAM_BLUE ? 'Blue wins' : 'Draw';
        this.view.hud.banner(msg.seriesOver ? 'FULL TIME' : 'ROUND OVER', w, '#ffffff', 3000);
        if (msg.seriesOver) setTimeout(() => this.showSummary(msg.winner, msg.scoreRed, msg.scoreBlue, msg.stats, msg.replayAvailable), 2000);
        break;
      }
      case 'error':
        toast(msg.message, 'error');
        if (msg.code === 'reconnect_failed') this.cb.exit(msg.message);
        break;
      case 'left':
        this.cb.exit(msg.reason);
        break;
      default:
        break;
    }
  }

  private onNetState(state: NetState, reason: string): void {
    if (state === 'reconnecting') {
      this.status = 'reconnecting';
      this.view?.hud.banner('Connection lost', 'Attempting to reconnect…', '#ffd166', 60_000);
    } else if (state === 'open') {
      if (this.status === 'reconnecting') this.view?.hud.banner('Reconnected', '', '#7ce0c3', 1200);
      this.status = 'connected';
    } else if (state === 'closed' && reason !== 'left') {
      this.cb.exit(reason || 'Connection lost');
    }
  }

  private onSnapshot(snap: DecodedSnapshot, bytes: number): void {
    const verdict = this.net.stats.onSnapshot(snap.seq, snap.serverTime, performance.now(), bytes);
    if (verdict !== 'ok') return; // duplicate or out-of-order
    if (snap.configVersion !== this.room.configVersion) return;
    const prevMatch = this.latest?.state.match;
    this.interp.push(snap.serverTime, snap.state);
    this.dilation.onSnapshot(snap.queueDepth, this.net.clock.jitter, 1000 / this.room.settings.tickRate);
    this.authoritativeEvents(prevMatch, snap);

    const wasPredicting = this.latest !== null && this.latest.state.players.some((p) => p.id === this.playerId);
    // Remember current predicted positions to smooth the correction.
    this.before.clear();
    for (const b of this.sim.world.bodies) this.before.set(b.id, { x: b.x, y: b.y });
    this.predictor.reconcile(snap);
    if (wasPredicting) {
      for (const b of this.sim.world.bodies) {
        const old = this.before.get(b.id);
        if (!old) continue;
        const dx = old.x - b.x;
        const dy = old.y - b.y;
        if (dx === 0 && dy === 0) continue;
        this.smoother.add(b.id, dx, dy);
        this.prev.shift(b.id, -dx, -dy);
      }
    }
    this.latest = snap;
    if (!prevMatch || prevMatch.phase !== snap.state.match.phase) this.refreshPanel();
  }

  private authoritativeEvents(prev: DecodedSnapshot['state']['match'] | undefined, snap: DecodedSnapshot): void {
    const m = snap.state.match;
    const fx = this.view?.effects;
    if (!fx) return;
    const tr = this.room.settings.tickRate;
    if (m.phase === PHASE_COUNTDOWN) {
      const n = Math.ceil(m.phaseTicks / tr);
      if (n !== this.lastCountdown) {
        this.lastCountdown = n;
        fx.countdown(n);
      }
    } else if (prev && prev.phase === PHASE_COUNTDOWN && m.phase === PHASE_PLAYING) {
      this.lastCountdown = -1;
      fx.countdown(0);
    }
    if (prev && prev.phase !== m.phase) {
      fx.phase(m.phase);
      if (m.phase === PHASE_HALFTIME) this.view.hud.banner('HALF TIME', '', '#ffffff', 2500);
      if (m.phase === PHASE_LOBBY) this.panel?.setVisible(true);
      if (prev.phase === PHASE_LOBBY && m.phase !== PHASE_LOBBY) this.panel?.setVisible(false);
    }
    if (prev && !prev.overtime && m.overtime) this.view.hud.banner('GOLDEN GOAL', 'Next goal wins', '#ffd166', 2500);
    // Kicks by other players observed through snapshots.
    for (const p of snap.state.players) {
      if (p.id === this.playerId) continue;
      const was = this.remoteLatch.get(p.id) ?? false;
      if (p.kickLatch && !was) fx.remoteKick(p.id, snap.state.ball.x, snap.state.ball.y);
      this.remoteLatch.set(p.id, p.kickLatch);
    }
  }

  private showSummary(winner: TeamId, scoreRed: number, scoreBlue: number, stats: MatchStats, replayAvailable: boolean): void {
    this.modal?.close();
    const players = this.roster.map((p) => ({ id: p.id, name: p.name, team: p.team }));
    this.modal = openModal(
      this.view.overlay,
      'Match over',
      matchSummary(winner, scoreRed, scoreBlue, stats, players),
      [
        ...(replayAvailable
          ? [
              {
                label: 'Save replay',
                primary: true,
                onClick: () => {
                  this.pendingReplaySave = true;
                  this.net.sendControl({ t: 'getReplay' });
                },
              },
            ]
          : []),
        { label: 'Close', onClick: () => this.modal?.close() },
      ],
      { wide: true, onClose: () => (this.modal = null) },
    );
  }

  private onReplay(bytes: Uint8Array): void {
    if (!this.pendingReplaySave) return;
    this.pendingReplaySave = false;
    const copy = bytes.slice();
    try {
      const data = decodeReplay(copy);
      const last = data.initialState.match;
      const ok = storeReplay(copy, {
        title: data.title,
        recordedAt: data.recordedAt,
        durationSec: Math.round((data.endTick - data.startTick) / data.tickRate),
        scoreRed: this.latest?.state.match.scoreRed ?? last.scoreRed,
        scoreBlue: this.latest?.state.match.scoreBlue ?? last.scoreBlue,
      });
      toast(ok ? 'Replay saved to your library (Main menu → Replays)' : 'Local storage full — downloading instead', ok ? 'success' : 'info');
      if (!ok) downloadBlob(copy, `momentum-${this.code}.mfr`, 'application/octet-stream');
    } catch (e) {
      toast(`Replay error: ${(e as Error).message}`, 'error');
    }
  }

  // ------------------------------------------------------------------ loop

  private get predicting(): boolean {
    return this.latest !== null && this.latest.state.players.some((p) => p.id === this.playerId);
  }

  update(dtMs: number, now: number): void {
    this.net.clock.update(dtMs);
    this.net.stats.update(now);
    this.smoother.decay(dtMs);
    if (!this.latest || !this.predicting || this.status !== 'connected') {
      this.accum = 0;
      return;
    }
    const tickMs = 1000 / this.room.settings.tickRate;
    // Time dilation: run slightly faster/slower to keep the server's input buffer small but non-empty.
    this.accum += dtMs * this.dilation.scale;
    let n = 0;
    while (this.accum >= tickMs && n < MAX_CATCHUP_TICKS) {
      this.accum -= tickMs;
      this.clientTick(now);
      n++;
    }
    if (n === MAX_CATCHUP_TICKS) this.accum = 0;
  }

  private clientTick(now: number): void {
    const sim = this.sim;
    this.prev.capture(sim.world);
    const inp = this.chat.focused || this.modal ? NEUTRAL : input.read(0);
    sim.world.recordContacts = settings.get().debug.overlay;
    this.predictor.advance(inp);
    this.tps.tick(now);
    for (const e of sim.events) {
      if (e.type === 'kick' || e.type === 'ballHit' || e.type === 'playerHit') this.view.effects.physical(e);
    }
    const pk = this.predictor.packetInputs(INPUT_REDUNDANCY);
    this.net.sendBinary(encodeInputPacket(pk[pk.length - 1]!.seq, pk.map((p) => p.input)));
  }

  private interpDelayMs(): number {
    const fixed = settings.get().network.interpolationMs;
    if (fixed > 0) return fixed;
    const interval = 1000 / this.room.settings.snapshotRate;
    return Math.max(25, interval * 1.6 + this.net.stats.arrivalJitter * 2 + 4);
  }

  fillFrame(frame: RenderFrame, now: number): void {
    const s = settings.get().network;
    const snap = this.latest;
    const sim = this.sim;
    frame.map = sim.map;
    frame.physics = sim.physics;
    frame.settings = this.room.settings.match;
    frame.tickRate = this.room.settings.tickRate;
    frame.focusId = this.playerId;
    frame.localTeam = this.myTeam;
    frame.net = {
      ping: this.net.clock.srtt,
      jitter: this.net.clock.jitter,
      loss: this.net.stats.loss,
      status: this.status,
      simulatedMs: s.simEnabled ? s.simLatency : 0,
    };
    frame.hudSub = this.myTeam === TEAM_SPECTATOR ? 'SPECTATING' : '';
    frame.debug.world = settings.get().debug.overlay ? sim.world : null;
    frame.debug.ghosts.length = 0;
    this.pool.begin(frame);
    if (!snap) return;
    frame.match = snap.state.match;

    const predicting = this.predicting;
    const tickMs = 1000 / this.room.settings.tickRate;
    const alpha = Math.min(1, this.accum / tickMs);
    const ip = this.interp.sample(this.net.clock.serverNow(now) - this.interpDelayMs());
    const kickOf = new Map(snap.state.players.map((p) => [p.id, p.kick]));

    const source = predicting ? sim.players.map((p) => p.id) : snap.state.players.map((p) => p.id);
    for (const id of source) {
      const r = this.roster.find((x) => x.id === id);
      const simP = sim.getPlayer(id);
      const snapP = snap.state.players.find((p) => p.id === id);
      const team = simP?.team ?? snapP?.team;
      if (!team) continue;
      const rp = this.pool.next(frame);
      rp.id = id;
      rp.team = team;
      rp.name = r?.name ?? '';
      rp.avatar = r?.avatar ?? '';
      rp.isLocal = id === this.playerId;
      const usePrediction = predicting && simP && (rp.isLocal || s.remoteMode === 'predict');
      const ipP = ip?.players.get(id);
      if (usePrediction && simP) {
        rp.x = this.prev.lerpX(id, simP.body.x, alpha) + this.smoother.x(id);
        rp.y = this.prev.lerpY(id, simP.body.y, alpha) + this.smoother.y(id);
        rp.vx = simP.body.vx;
        rp.vy = simP.body.vy;
        rp.kicking = rp.isLocal ? simP.kick : (kickOf.get(id) ?? false);
      } else if (ipP) {
        rp.x = ipP.x;
        rp.y = ipP.y;
        rp.vx = ipP.vx;
        rp.vy = ipP.vy;
        rp.kicking = kickOf.get(id) ?? false;
      } else if (snapP) {
        rp.x = snapP.x;
        rp.y = snapP.y;
        rp.vx = snapP.vx;
        rp.vy = snapP.vy;
        rp.kicking = snapP.kick;
      }
      if (ipP && usePrediction) frame.debug.ghosts.push({ x: ipP.x, y: ipP.y, r: sim.physics.playerRadius, kind: 'interp' });
    }
    if (predicting && s.ballMode === 'predict') {
      const b = sim.ball;
      frame.ball.x = this.prev.lerpX(b.id, b.x, alpha) + this.smoother.x(b.id);
      frame.ball.y = this.prev.lerpY(b.id, b.y, alpha) + this.smoother.y(b.id);
      frame.ball.vx = b.vx;
      frame.ball.vy = b.vy;
      frame.ball.w = b.w;
    } else if (ip) {
      frame.ball.x = ip.ball.x;
      frame.ball.y = ip.ball.y;
      frame.ball.vx = ip.ball.vx;
      frame.ball.vy = ip.ball.vy;
      frame.ball.w = snap.state.ball.w;
    }
    // Debug: authoritative (past) positions of me and the ball.
    const meSnap = snap.state.players.find((p) => p.id === this.playerId);
    if (meSnap) frame.debug.ghosts.push({ x: meSnap.x, y: meSnap.y, r: sim.physics.playerRadius, kind: 'server' });
    frame.debug.ghosts.push({ x: snap.state.ball.x, y: snap.state.ball.y, r: sim.physics.ballRadius, kind: 'server' });
  }

  debugLines(): string[] {
    const st = this.net.stats;
    const c = this.net.clock;
    const snap = this.latest;
    const me = this.sim.getPlayer(this.playerId);
    const b = this.sim.ball;
    const serverTick = snap ? snap.state.tick : 0;
    return [
      `Physics TPS ${this.tps.rate.toFixed(1)}  (dilation ×${this.dilation.scale.toFixed(3)})`,
      `Ping        ${fmt(c.srtt, 0)} ms   Jitter ${fmt(c.jitter, 1)} ms`,
      `Packet loss ${(st.loss * 100).toFixed(2)} %   dup ${st.duplicates}  ooo ${st.outOfOrder}`,
      `Bandwidth   ↓${(st.bandwidthIn / 1024).toFixed(1)} KB/s  ↑${(st.bandwidthOut / 1024).toFixed(1)} KB/s`,
      `Server tick ${serverTick}   Client tick ${this.sim.tick}  (+${this.predictor.pendingCount} predicted)`,
      `Input buf   server depth ${snap?.queueDepth ?? 0}  target ${this.dilation.target.toFixed(1)}  avg ${this.dilation.averageDepth.toFixed(1)}`,
      `Interp      delay ${fmt(this.interpDelayMs(), 0)} ms  buffer ${this.interp.size}`,
      `Pred error  ${fmt(this.predictor.predictionError, 2)} u   replayed ${this.predictor.lastReplayCount} ticks`,
      `Collisions  ${this.sim.world.collisionCount}   micro-steps ${this.sim.world.lastMicroSteps}`,
      me ? `Player pos  ${fmt(me.body.x)}, ${fmt(me.body.y)}  vel ${fmt(me.body.vx)}, ${fmt(me.body.vy)}` : 'Player      spectating',
      `Ball pos    ${fmt(b.x)}, ${fmt(b.y)}  vel ${fmt(b.vx)}, ${fmt(b.vy)}  spin ${fmt(b.w, 2)}`,
      this.stats ? `Possession  red ${this.stats.possessionRed} / blue ${this.stats.possessionBlue} ticks` : 'Possession  —',
    ];
  }

  onMenu(): void {
    if (this.modal) {
      this.modal.close();
      return;
    }
    this.panel.toggle();
  }

  destroy(): void {
    this.modal?.close();
    this.panel?.destroy();
    this.chat?.destroy();
    sessionSet(REJOIN_KEY, null);
    this.net.close();
  }
}
