import {
  AXIS_MAX,
  CAT_ALL,
  CAT_BALL,
  CAT_BLUE,
  CAT_RED,
  PHASE_COUNTDOWN,
  PHASE_GOAL_PAUSE,
  PHASE_HALFTIME,
  PHASE_LOBBY,
  PHASE_MATCH_END,
  PHASE_PLAYING,
  PHASE_RESETTING,
  SUBSTEP_HZ,
  TAG_NET,
  TAG_POST,
  TEAM_BLUE,
  TEAM_RED,
  TEAM_SPECTATOR,
  otherTeam,
  type MatchPhase,
  type PlayingTeam,
  type TeamId,
} from '../constants/game.ts';
import type { PhysicsConfig } from '../constants/physics-config.ts';
import { createBody, PhysicsWorld, type Body } from '../physics/world.ts';
import type { MatchSettings, MatchStateData, MatchStats, PlayerStateData, SimStateData } from '../types/index.ts';
import { formationPosition } from './formation.ts';
import { buildArena, type ArenaGeometry, type MapDef } from './maps.ts';
import { Rng } from './rng.ts';
import { StatsTracker } from './stats.ts';

export interface SimPlayer {
  id: number;
  team: PlayingTeam;
  body: Body;
  /** Current input (quantised axes). */
  ix: number;
  iy: number;
  kick: boolean;
  /** True after a kick until the kick button is released (one kick per press). */
  kickLatch: boolean;
  /** Ticks until this player may kick again. */
  cooldown: number;
  /** In contact with the ball at the end of the previous substep (touch stats). */
  touching: boolean;
  touchNow: boolean;
}

export type BallSurface = 'wall' | 'post' | 'net' | 'player';

export type SimEvent =
  | { type: 'kick'; playerId: number; x: number; y: number; dirX: number; dirY: number; speed: number }
  | { type: 'ballHit'; surface: BallSurface; playerId: number; x: number; y: number; speed: number }
  | { type: 'playerHit'; a: number; b: number; x: number; y: number; speed: number }
  | { type: 'goal'; team: PlayingTeam; scorerId: number; assistId: number; ownGoal: boolean; practice: boolean; x: number; y: number; speed: number }
  | { type: 'phase'; phase: MatchPhase; prev: MatchPhase }
  | { type: 'countdown'; value: number }
  | { type: 'overtime' }
  | { type: 'matchEnd'; winner: TeamId; seriesOver: boolean }
  | { type: 'kickoffRelease' }
  | { type: 'fault'; reason: string };

export interface SimOptions {
  map: MapDef;
  physics: PhysicsConfig;
  settings: MatchSettings;
  tickRate: number;
  seed: number;
}

const BALL_ID = 0;
const HIT_EVENT_MIN_SPEED = 35;
const RESET_SECONDS = 0.25;
const HALFTIME_SECONDS = 3;
const MATCH_END_SECONDS = 5;
const PRACTICE_RESET_SECONDS = 1;
const KICKOFF_BARRIER_TIMEOUT_SECONDS = 10;

export function emptyMatchState(): MatchStateData {
  return {
    phase: PHASE_LOBBY,
    phaseTicks: 0,
    scoreRed: 0,
    scoreBlue: 0,
    timeTicks: 0,
    kickoffTeam: TEAM_RED,
    firstKickoffTeam: TEAM_RED,
    kickoffActive: false,
    overtime: false,
    matchOver: false,
    half: 1,
    round: 1,
    roundWinsRed: 0,
    roundWinsBlue: 0,
    ballResetTicks: 0,
    lastTouchId: 0,
    prevTouchId: 0,
  };
}

/**
 * The complete, deterministic game simulation: physics world + match state
 * machine. The same class runs on the server (authority), on clients
 * (prediction), in local/offline sessions and in the replay viewer.
 *
 * Determinism contract: identical initial state + identical per-tick inputs +
 * identical config ⇒ bit-identical state after every tick.
 */
export class GameSimulation {
  readonly world = new PhysicsWorld();
  map: MapDef;
  physics: PhysicsConfig;
  settings: MatchSettings;
  readonly tickRate: number;
  readonly substeps: number;
  readonly h: number;
  arena!: ArenaGeometry;

  tick = 0;
  rng: Rng;
  players: SimPlayer[] = [];
  readonly ball: Body;
  match: MatchStateData = emptyMatchState();
  readonly stats = new StatsTracker();

  /** Events produced by the last `step()`. */
  readonly events: SimEvent[] = [];
  /** Disable while re-simulating (client reconciliation) to avoid duplicate effects. */
  emitEvents = true;

  private cooldownTicks = 0;
  private goalThisTick = false;

  constructor(opts: SimOptions) {
    this.map = opts.map;
    this.physics = { ...opts.physics };
    this.settings = { ...opts.settings };
    this.tickRate = opts.tickRate;
    this.substeps = Math.max(1, Math.round(SUBSTEP_HZ / opts.tickRate));
    this.h = 1 / SUBSTEP_HZ;
    this.rng = new Rng(opts.seed);
    this.ball = createBody(BALL_ID);
    this.world.addBody(this.ball);
    this.world.onContact = (a, b, tag, x, y, nx, ny, speed) => this.onContact(a, b, tag, x, y, nx, ny, speed);
    this.applyPhysics(this.physics);
  }

  // ---------------------------------------------------------------- config

  /** Applies a physics configuration to all bodies and rebuilds the arena. */
  applyPhysics(cfg: PhysicsConfig): void {
    this.physics = { ...cfg };
    const barrierState = this.arena ? this.match.kickoffActive : false;
    this.arena = buildArena(this.map, cfg);
    this.world.segments = [...this.arena.segments, ...this.arena.barrierRed, ...this.arena.barrierBlue];
    this.world.planes = this.arena.planes;
    this.world.circles = this.arena.circles;
    this.world.iterations = cfg.solverIterations;
    this.cooldownTicks = Math.round(cfg.kickCooldown * this.tickRate);

    const b = this.ball;
    b.radius = cfg.ballRadius;
    b.invMass = 1 / cfg.ballMass;
    b.invInertia = cfg.spinEnabled ? 2 / (cfg.ballMass * cfg.ballRadius * cfg.ballRadius) : 0;
    b.restitution = cfg.ballRestitution;
    b.friction = cfg.spinEnabled ? cfg.ballFriction : 0;
    b.drag = cfg.ballDamping;
    b.airDrag = cfg.ballAirResistance;
    b.magnus = cfg.spinEnabled ? cfg.spinCurve : 0;
    b.spinDamping = cfg.spinDamping;
    b.maxSpin = cfg.ballMaxSpin;
    b.maxSpeed = cfg.ballMaxSpeed;
    b.category = CAT_BALL;
    b.mask = CAT_ALL;
    if (!cfg.spinEnabled) b.w = 0;

    for (const p of this.players) this.configurePlayerBody(p);
    this.match.kickoffActive = barrierState;
    this.updateBarriers();
  }

  setSettings(settings: MatchSettings): void {
    this.settings = { ...settings };
  }

  private configurePlayerBody(p: SimPlayer): void {
    const cfg = this.physics;
    const b = p.body;
    b.radius = cfg.playerRadius;
    b.invMass = 1 / cfg.playerMass;
    b.invInertia = 0;
    b.restitution = cfg.playerRestitution;
    b.friction = 0;
    b.drag = cfg.playerFriction;
    b.airDrag = cfg.playerAirResistance;
    b.magnus = 0;
    b.maxSpeed = cfg.playerMaxSpeed;
    b.category = p.team === TEAM_RED ? CAT_RED : CAT_BLUE;
    b.mask = CAT_ALL;
  }

  // ---------------------------------------------------------------- roster

  getPlayer(id: number): SimPlayer | undefined {
    for (const p of this.players) if (p.id === id) return p;
    return undefined;
  }

  addPlayer(id: number, team: PlayingTeam): SimPlayer {
    const existing = this.getPlayer(id);
    if (existing) {
      this.setPlayerTeam(id, team);
      return existing;
    }
    const body = createBody(id);
    const p: SimPlayer = { id, team, body, ix: 0, iy: 0, kick: false, kickLatch: false, cooldown: 0, touching: false, touchNow: false };
    this.configurePlayerBody(p);
    this.players.push(p);
    this.players.sort((a, b) => a.id - b.id);
    this.world.addBody(body);
    this.spawnPlayer(p);
    body.frozen = this.isFrozenPhase();
    return p;
  }

  removePlayer(id: number): void {
    const p = this.getPlayer(id);
    if (!p) return;
    this.world.removeBody(p.body);
    this.players.splice(this.players.indexOf(p), 1);
  }

  /** Moves a player to another team (or removes them when spectating). */
  setPlayerTeam(id: number, team: TeamId): void {
    if (team === TEAM_SPECTATOR) {
      this.removePlayer(id);
      return;
    }
    const p = this.getPlayer(id);
    if (!p) {
      this.addPlayer(id, team);
      return;
    }
    if (p.team === team) return;
    p.team = team;
    this.configurePlayerBody(p);
    this.spawnPlayer(p);
  }

  private spawnPlayer(p: SimPlayer): void {
    const mates = this.players.filter((q) => q.team === p.team);
    const index = mates.indexOf(p);
    const pos = formationPosition(this.map, p.team, index, mates.length);
    const b = p.body;
    b.x = pos.x;
    b.y = pos.y;
    b.vx = 0;
    b.vy = 0;
    b.ax = 0;
    b.ay = 0;
  }

  setInput(id: number, x: number, y: number, kick: boolean): void {
    const p = this.getPlayer(id);
    if (!p) return;
    p.ix = clampAxis(x);
    p.iy = clampAxis(y);
    p.kick = kick;
  }

  teamCount(team: PlayingTeam): number {
    let n = 0;
    for (const p of this.players) if (p.team === team) n++;
    return n;
  }

  // ---------------------------------------------------------------- match control

  startMatch(): void {
    const m = this.match;
    m.scoreRed = 0;
    m.scoreBlue = 0;
    m.timeTicks = 0;
    m.half = 1;
    m.round = 1;
    m.roundWinsRed = 0;
    m.roundWinsBlue = 0;
    m.overtime = false;
    m.matchOver = false;
    m.ballResetTicks = 0;
    m.lastTouchId = 0;
    m.prevTouchId = 0;
    m.firstKickoffTeam = this.rng.nextU32() & 1 ? TEAM_BLUE : TEAM_RED;
    m.kickoffTeam = m.firstKickoffTeam;
    this.stats.reset();
    this.enterResetting();
  }

  stopMatch(): void {
    const m = this.match;
    m.kickoffActive = false;
    m.overtime = false;
    m.matchOver = false;
    m.ballResetTicks = 0;
    m.phaseTicks = 0;
    this.setPhase(PHASE_LOBBY);
    this.updateBarriers();
    this.updateFrozen();
  }

  /** Starts free play (training / practice) without timer or kickoff. */
  startFreePlay(): void {
    this.stopMatch();
    this.resetPositions();
    this.setPhase(PHASE_PLAYING);
    this.updateFrozen();
  }

  private enterResetting(): void {
    this.match.phaseTicks = Math.max(1, Math.round(RESET_SECONDS * this.tickRate));
    this.match.kickoffActive = this.settings.kickoffBarrier;
    this.setPhase(PHASE_RESETTING);
    this.resetPositions();
    this.updateBarriers();
    this.updateFrozen();
  }

  private enterCountdownOrPlay(): void {
    const m = this.match;
    if (this.settings.countdownSeconds > 0) {
      m.phaseTicks = this.settings.countdownSeconds * this.tickRate;
      this.setPhase(PHASE_COUNTDOWN);
      this.emit({ type: 'countdown', value: this.settings.countdownSeconds });
    } else {
      this.enterPlaying();
    }
    this.updateFrozen();
  }

  private enterPlaying(): void {
    const m = this.match;
    m.phaseTicks = 0; // counts ticks since kickoff while PLAYING
    m.kickoffActive = this.settings.kickoffBarrier;
    this.setPhase(PHASE_PLAYING);
    this.emit({ type: 'countdown', value: 0 });
    this.updateBarriers();
  }

  private enterMatchEnd(): void {
    const m = this.match;
    let winner: TeamId = TEAM_SPECTATOR;
    if (m.scoreRed > m.scoreBlue) winner = TEAM_RED;
    else if (m.scoreBlue > m.scoreRed) winner = TEAM_BLUE;
    if (winner === TEAM_RED) m.roundWinsRed++;
    else if (winner === TEAM_BLUE) m.roundWinsBlue++;
    m.kickoffActive = false;
    m.phaseTicks = MATCH_END_SECONDS * this.tickRate;
    this.setPhase(PHASE_MATCH_END);
    this.updateBarriers();
    this.emit({ type: 'matchEnd', winner, seriesOver: this.isSeriesOver() });
  }

  isSeriesOver(): boolean {
    const need = Math.ceil(this.settings.rounds / 2);
    return this.settings.rounds <= 1 || this.match.roundWinsRed >= need || this.match.roundWinsBlue >= need;
  }

  /** Puts every body at its kickoff position with zero velocity. */
  resetPositions(): void {
    const b = this.ball;
    b.x = 0;
    b.y = 0;
    b.vx = 0;
    b.vy = 0;
    b.w = 0;
    for (const team of [TEAM_RED, TEAM_BLUE] as const) {
      const mates = this.players.filter((p) => p.team === team);
      for (let i = 0; i < mates.length; i++) {
        const p = mates[i]!;
        const pos = formationPosition(this.map, team, i, mates.length);
        p.body.x = pos.x;
        p.body.y = pos.y;
        p.body.vx = 0;
        p.body.vy = 0;
        p.cooldown = 0;
      }
    }
  }

  resetBall(x = 0, y = 0, vx = 0, vy = 0): void {
    const b = this.ball;
    b.x = x;
    b.y = y;
    b.vx = vx;
    b.vy = vy;
    b.w = 0;
  }

  // ---------------------------------------------------------------- stepping

  isFrozenPhase(): boolean {
    const phase = this.match.phase;
    return phase === PHASE_COUNTDOWN || phase === PHASE_RESETTING;
  }

  private updateFrozen(): void {
    const frozen = this.isFrozenPhase();
    this.ball.frozen = frozen;
    for (const p of this.players) p.body.frozen = frozen;
    if (frozen) {
      this.ball.vx = this.ball.vy = this.ball.w = 0;
      for (const p of this.players) p.body.vx = p.body.vy = 0;
    }
  }

  private updateBarriers(): void {
    const m = this.match;
    const active = m.kickoffActive && (m.phase === PHASE_PLAYING || m.phase === PHASE_COUNTDOWN || m.phase === PHASE_RESETTING);
    for (const s of this.arena.barrierRed) s.enabled = active && m.kickoffTeam === TEAM_RED;
    for (const s of this.arena.barrierBlue) s.enabled = active && m.kickoffTeam === TEAM_BLUE;
  }

  /** Advances the simulation by exactly one tick. */
  step(): void {
    this.events.length = 0;
    this.goalThisTick = false;
    const frozen = this.isFrozenPhase();
    const cfg = this.physics;

    // 1. Inputs → accelerations (normalised so diagonals are not faster).
    for (const p of this.players) {
      const b = p.body;
      if (frozen) {
        b.ax = b.ay = 0;
        continue;
      }
      let x = p.ix / AXIS_MAX;
      let y = p.iy / AXIS_MAX;
      const l2 = x * x + y * y;
      if (l2 > 1) {
        const inv = 1 / Math.sqrt(l2);
        x *= inv;
        y *= inv;
      }
      const acc = cfg.playerAcceleration * (p.kick ? cfg.playerKickingAcceleration : 1);
      b.ax = x * acc;
      b.ay = y * acc;
    }

    // 2. Kicks (impulses on the ball).
    for (const p of this.players) {
      if (p.cooldown > 0) p.cooldown--;
      if (!p.kick) {
        p.kickLatch = false;
        continue;
      }
      if (frozen || p.kickLatch || p.cooldown > 0) continue;
      this.tryKick(p);
    }

    // 3. Physics substeps with goal detection after each one.
    if (!frozen) {
      for (let s = 0; s < this.substeps; s++) {
        this.world.step(this.h);
        this.processTouches();
        if (!this.goalThisTick) this.checkGoal();
      }
    }

    // 4. Match state machine.
    this.updateMatch();

    // 5. Quantise to float32 so network snapshots represent the state exactly.
    this.quantize();
    this.sanityCheck();
    this.tick++;
  }

  private tryKick(p: SimPlayer): void {
    const ball = this.ball;
    const b = p.body;
    const cfg = this.physics;
    const dx = ball.x - b.x;
    const dy = ball.y - b.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist - b.radius - ball.radius > cfg.kickRadius) return;
    let nx = 1;
    let ny = 0;
    if (dist > 0) {
      nx = dx / dist;
      ny = dy / dist;
    }

    // Movement input bends the kick away from the player→ball line.
    let ix = p.ix / AXIS_MAX;
    let iy = p.iy / AXIS_MAX;
    const il2 = ix * ix + iy * iy;
    if (il2 > 1) {
      const inv = 1 / Math.sqrt(il2);
      ix *= inv;
      iy *= inv;
    }
    let dirX = nx + cfg.kickAimInfluence * ix;
    let dirY = ny + cfg.kickAimInfluence * iy;
    const along = dirX * nx + dirY * ny;
    const minAlong = 0.2;
    if (along < minAlong) {
      dirX += (minAlong - along) * nx;
      dirY += (minAlong - along) * ny;
    }
    const dl = Math.sqrt(dirX * dirX + dirY * dirY);
    dirX /= dl;
    dirY /= dl;

    const J = cfg.kickForce;
    ball.vx += dirX * J * ball.invMass;
    ball.vy += dirY * J * ball.invMass;
    b.vx -= dirX * J * b.invMass * cfg.kickRecoil;
    b.vy -= dirY * J * b.invMass * cfg.kickRecoil;

    if (ball.invInertia > 0) {
      // Impulse applied at the contact point r = −n·R: off-centre kicks spin the ball.
      const rx = -nx * ball.radius;
      const ry = -ny * ball.radius;
      const torque = rx * dirY * J - ry * dirX * J;
      let w = ball.w + ball.invInertia * torque * cfg.spinKickFactor;
      if (w > ball.maxSpin) w = ball.maxSpin;
      else if (w < -ball.maxSpin) w = -ball.maxSpin;
      ball.w = w;
    }

    p.kickLatch = true;
    p.cooldown = this.cooldownTicks;
    this.registerTouch(p);
    if (this.match.phase === PHASE_PLAYING && this.settings.mode !== 'training') {
      const st = this.stats.get(p.id);
      st.kicks++;
      if (this.isShot(p.team)) st.shots++;
    }
    this.releaseKickoff();
    if (this.emitEvents) {
      const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
      this.events.push({ type: 'kick', playerId: p.id, x: ball.x - nx * ball.radius, y: ball.y - ny * ball.radius, dirX, dirY, speed });
    }
  }

  /** Whether the ball's current straight-line path enters the opponent goal mouth. */
  private isShot(team: PlayingTeam): boolean {
    const b = this.ball;
    const W = this.map.halfWidth;
    const goalX = team === TEAM_RED ? W : -W;
    const vx = b.vx;
    if (vx === 0 || Math.sign(goalX - b.x) !== Math.sign(vx)) return false;
    const t = (goalX - b.x) / vx;
    const y = b.y + b.vy * t;
    return Math.abs(y) < this.map.goalHalfWidth;
  }

  private onContact(a: Body, b: Body | null, tag: number, x: number, y: number, _nx: number, _ny: number, speed: number): void {
    const ball = this.ball;
    if (a === ball || b === ball) {
      const other = a === ball ? b : a;
      if (other) {
        const p = this.getPlayer(other.id);
        if (p) p.touchNow = true;
        if (this.emitEvents && speed > HIT_EVENT_MIN_SPEED) {
          this.events.push({ type: 'ballHit', surface: 'player', playerId: other.id, x, y, speed });
        }
      } else if (this.emitEvents && speed > HIT_EVENT_MIN_SPEED) {
        const surface = tag === TAG_POST ? 'post' : tag === TAG_NET ? 'net' : 'wall';
        this.events.push({ type: 'ballHit', surface, playerId: 0, x, y, speed });
      }
      return;
    }
    if (b && this.emitEvents && speed > HIT_EVENT_MIN_SPEED * 2) {
      this.events.push({ type: 'playerHit', a: a.id, b: b.id, x, y, speed });
    }
  }

  private registerTouch(p: SimPlayer): void {
    const m = this.match;
    if (m.lastTouchId !== p.id) {
      m.prevTouchId = m.lastTouchId;
      m.lastTouchId = p.id;
    }
  }

  private processTouches(): void {
    let touched = false;
    for (const p of this.players) {
      if (p.touchNow) {
        touched = true;
        if (!p.touching) {
          this.registerTouch(p);
          if (this.match.phase === PHASE_PLAYING && this.settings.mode !== 'training') this.stats.get(p.id).touches++;
        }
      }
      p.touching = p.touchNow;
      p.touchNow = false;
    }
    if (touched) this.releaseKickoff();
  }

  private releaseKickoff(): void {
    const m = this.match;
    if (m.kickoffActive && m.phase === PHASE_PLAYING) {
      m.kickoffActive = false;
      this.updateBarriers();
      this.emit({ type: 'kickoffRelease' });
    }
  }

  private teamOf(id: number): PlayingTeam | 0 {
    const p = this.getPlayer(id);
    return p ? p.team : 0;
  }

  private checkGoal(): void {
    const m = this.match;
    const practice = m.phase === PHASE_LOBBY || this.settings.mode === 'training';
    if (!practice && m.phase !== PHASE_PLAYING) return;
    if (practice && m.ballResetTicks > 0) return;
    const b = this.ball;
    const W = this.map.halfWidth;
    if (Math.abs(b.y) >= this.map.goalHalfWidth) return;
    let team: PlayingTeam;
    if (b.x - b.radius > W) team = TEAM_RED;
    else if (b.x + b.radius < -W) team = TEAM_BLUE;
    else return;

    this.goalThisTick = true;
    const lastTeam = this.teamOf(m.lastTouchId);
    const ownGoal = lastTeam !== 0 && lastTeam !== team;
    const scorerId = lastTeam !== 0 ? m.lastTouchId : 0;
    let assistId = 0;
    if (!ownGoal && scorerId !== 0 && m.prevTouchId !== 0 && m.prevTouchId !== scorerId && this.teamOf(m.prevTouchId) === team) {
      assistId = m.prevTouchId;
    }
    const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    this.emit({ type: 'goal', team, scorerId, assistId, ownGoal, practice, x: b.x, y: b.y, speed });

    if (team === TEAM_RED) m.scoreRed++;
    else m.scoreBlue++;

    if (practice) {
      m.ballResetTicks = Math.round(PRACTICE_RESET_SECONDS * this.tickRate);
      return;
    }

    if (scorerId !== 0) {
      const st = this.stats.get(scorerId);
      if (ownGoal) st.ownGoals++;
      else st.goals++;
    }
    if (assistId !== 0) this.stats.get(assistId).assists++;

    const limit = this.settings.scoreLimit;
    if (m.overtime || (limit > 0 && (m.scoreRed >= limit || m.scoreBlue >= limit))) m.matchOver = true;
    m.kickoffTeam = otherTeam(team);
    m.kickoffActive = false;
    m.phaseTicks = this.settings.goalPauseSeconds * this.tickRate;
    this.setPhase(PHASE_GOAL_PAUSE);
    this.updateBarriers();
  }

  private updateMatch(): void {
    const m = this.match;
    const tr = this.tickRate;
    switch (m.phase) {
      case PHASE_LOBBY:
        this.tickPracticeReset();
        break;
      case PHASE_RESETTING:
        if (--m.phaseTicks <= 0) this.enterCountdownOrPlay();
        break;
      case PHASE_COUNTDOWN: {
        const before = Math.ceil(m.phaseTicks / tr);
        m.phaseTicks--;
        if (m.phaseTicks <= 0) {
          this.enterPlaying();
          this.updateFrozen();
        } else {
          const after = Math.ceil(m.phaseTicks / tr);
          if (after !== before) this.emit({ type: 'countdown', value: after });
        }
        break;
      }
      case PHASE_PLAYING: {
        if (this.settings.mode === 'training') {
          m.timeTicks++;
          this.tickPracticeReset();
          break;
        }
        m.timeTicks++;
        m.phaseTicks++;
        if (m.kickoffActive && m.phaseTicks >= KICKOFF_BARRIER_TIMEOUT_SECONDS * tr) this.releaseKickoff();
        const lastTeam = this.teamOf(m.lastTouchId);
        if (lastTeam === TEAM_RED) this.stats.possessionRed++;
        else if (lastTeam === TEAM_BLUE) this.stats.possessionBlue++;

        const limitTicks = this.settings.timeLimit * tr;
        if (limitTicks > 0 && !m.overtime) {
          if (this.settings.halftime && m.half === 1 && m.timeTicks >= Math.floor(limitTicks / 2) && m.timeTicks < limitTicks) {
            m.half = 2;
            m.kickoffTeam = otherTeam(m.firstKickoffTeam);
            m.kickoffActive = false;
            m.phaseTicks = HALFTIME_SECONDS * tr;
            this.setPhase(PHASE_HALFTIME);
            this.updateBarriers();
          } else if (m.timeTicks >= limitTicks) {
            const tied = m.scoreRed === m.scoreBlue;
            if (tied && (this.settings.overtime || this.settings.mode === 'tournament')) {
              m.overtime = true;
              this.emit({ type: 'overtime' });
            } else {
              m.matchOver = true;
              this.enterMatchEnd();
            }
          }
        }
        break;
      }
      case PHASE_GOAL_PAUSE:
        if (--m.phaseTicks <= 0) {
          if (m.matchOver) this.enterMatchEnd();
          else this.enterResetting();
        }
        break;
      case PHASE_HALFTIME:
        if (--m.phaseTicks <= 0) this.enterResetting();
        break;
      case PHASE_MATCH_END:
        if (m.phaseTicks > 0 && --m.phaseTicks <= 0) {
          if (!this.isSeriesOver()) {
            m.round++;
            m.scoreRed = 0;
            m.scoreBlue = 0;
            m.timeTicks = 0;
            m.half = 1;
            m.overtime = false;
            m.matchOver = false;
            m.firstKickoffTeam = otherTeam(m.firstKickoffTeam);
            m.kickoffTeam = m.firstKickoffTeam;
            this.enterResetting();
          } else if (this.settings.returnToLobby) {
            this.stopMatch();
          }
        }
        break;
    }
  }

  private tickPracticeReset(): void {
    const m = this.match;
    if (m.ballResetTicks > 0 && --m.ballResetTicks === 0) this.resetBall();
  }

  private setPhase(phase: MatchPhase): void {
    const prev = this.match.phase;
    this.match.phase = phase;
    if (prev !== phase) this.emit({ type: 'phase', phase, prev });
  }

  private emit(e: SimEvent): void {
    if (this.emitEvents) this.events.push(e);
  }

  private quantize(): void {
    const f = Math.fround;
    for (const b of this.world.bodies) {
      b.x = f(b.x);
      b.y = f(b.y);
      b.vx = f(b.vx);
      b.vy = f(b.vy);
      b.w = f(b.w);
    }
  }

  /** Defence in depth: a corrupted state must never propagate or crash a room. */
  private sanityCheck(): void {
    let bad = false;
    for (const b of this.world.bodies) {
      if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.vx) || !Number.isFinite(b.vy) || !Number.isFinite(b.w)) {
        bad = true;
        break;
      }
      const limit = this.arena.outerX + b.radius * 4;
      if (Math.abs(b.x) > limit || Math.abs(b.y) > this.arena.outerY + b.radius * 4) {
        bad = true;
        break;
      }
    }
    if (bad) {
      this.resetPositions();
      this.emit({ type: 'fault', reason: 'invalid body state; positions reset' });
    }
  }

  // ---------------------------------------------------------------- state I/O

  getState(): SimStateData {
    const b = this.ball;
    return {
      tick: this.tick,
      rng: this.rng.state,
      ball: { x: b.x, y: b.y, vx: b.vx, vy: b.vy, w: b.w },
      match: { ...this.match },
      players: this.players.map(
        (p): PlayerStateData => ({
          id: p.id,
          team: p.team,
          x: p.body.x,
          y: p.body.y,
          vx: p.body.vx,
          vy: p.body.vy,
          ix: p.ix,
          iy: p.iy,
          kick: p.kick,
          kickLatch: p.kickLatch,
          cooldown: p.cooldown,
          touching: p.touching,
        }),
      ),
    };
  }

  /** Restores a complete state (snapshot, keyframe). The roster is rebuilt to match. */
  setState(s: SimStateData): void {
    this.tick = s.tick;
    this.rng.state = s.rng >>> 0;
    Object.assign(this.match, s.match);

    // Remove players that do not exist in the state.
    for (let i = this.players.length - 1; i >= 0; i--) {
      const p = this.players[i]!;
      if (!s.players.some((q) => q.id === p.id)) {
        this.world.removeBody(p.body);
        this.players.splice(i, 1);
      }
    }
    for (const q of s.players) {
      let p = this.getPlayer(q.id);
      if (!p) {
        const body = createBody(q.id);
        p = { id: q.id, team: q.team, body, ix: 0, iy: 0, kick: false, kickLatch: false, cooldown: 0, touching: false, touchNow: false };
        this.players.push(p);
        this.world.addBody(body);
      }
      if (p.team !== q.team || p.body.category === 0) {
        p.team = q.team;
        this.configurePlayerBody(p);
      }
      p.body.x = q.x;
      p.body.y = q.y;
      p.body.vx = q.vx;
      p.body.vy = q.vy;
      p.ix = q.ix;
      p.iy = q.iy;
      p.kick = q.kick;
      p.kickLatch = q.kickLatch;
      p.cooldown = q.cooldown;
      p.touching = q.touching;
      p.touchNow = false;
    }
    this.players.sort((a, b) => a.id - b.id);

    const b = this.ball;
    b.x = s.ball.x;
    b.y = s.ball.y;
    b.vx = s.ball.vx;
    b.vy = s.ball.vy;
    b.w = s.ball.w;
    this.updateBarriers();
    const frozen = this.isFrozenPhase();
    this.ball.frozen = frozen;
    for (const p of this.players) p.body.frozen = frozen;
  }

  getStats(): MatchStats {
    return this.stats.snapshot();
  }

  /** 32-bit FNV-1a hash over the complete dynamic state (determinism checks). */
  hash(): number {
    const s = this.getState();
    const nums: number[] = [s.tick, s.rng, s.ball.x, s.ball.y, s.ball.vx, s.ball.vy, s.ball.w];
    const m = s.match;
    nums.push(m.phase, m.phaseTicks, m.scoreRed, m.scoreBlue, m.timeTicks, m.kickoffTeam, m.kickoffActive ? 1 : 0, m.overtime ? 1 : 0, m.round);
    for (const p of s.players) nums.push(p.id, p.team, p.x, p.y, p.vx, p.vy, p.ix, p.iy, p.kick ? 1 : 0, p.kickLatch ? 1 : 0, p.cooldown);
    return hashNumbers(nums);
  }
}

export function clampAxis(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const r = Math.round(v);
  return r > AXIS_MAX ? AXIS_MAX : r < -AXIS_MAX ? -AXIS_MAX : r;
}

const hashBuf = new Float64Array(1);
const hashWords = new Uint32Array(hashBuf.buffer);

export function hashNumbers(nums: readonly number[]): number {
  let h = 0x811c9dc5;
  for (const n of nums) {
    hashBuf[0] = n;
    for (let i = 0; i < 2; i++) {
      h ^= hashWords[i]!;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}
