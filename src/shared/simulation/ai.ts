import { AXIS_MAX, PHASE_COUNTDOWN, PHASE_RESETTING, TEAM_RED } from '../constants/game.ts';
import type { BotDifficulty, InputState } from '../types/index.ts';
import { Rng } from './rng.ts';
import type { GameSimulation, SimPlayer } from './simulation.ts';

interface BotParams {
  /** Ticks between decisions (reaction time). */
  thinkInterval: number;
  /** Aim spread as a fraction of the goal half-width. */
  aimSpread: number;
  /** Minimum cos(angle) between ball→goal and player→ball before shooting. */
  shootAlignment: number;
  /** Input magnitude (slower bots feel fairer on easy). */
  effort: number;
  /** Random steering noise. */
  jitter: number;
}

const PARAMS: Record<BotDifficulty, BotParams> = {
  easy: { thinkInterval: 12, aimSpread: 1.4, shootAlignment: 0.55, effort: 0.72, jitter: 0.35 },
  normal: { thinkInterval: 6, aimSpread: 0.7, shootAlignment: 0.8, effort: 0.92, jitter: 0.15 },
  hard: { thinkInterval: 2, aimSpread: 0.35, shootAlignment: 0.9, effort: 1, jitter: 0.03 },
};

export type Role = 'attacker' | 'keeper' | 'support';

/**
 * A bot only ever produces an InputState — exactly like a human. It has no
 * special access to the physics, so bots are bound by the same rules.
 */
export class BotBrain {
  readonly id: number;
  difficulty: BotDifficulty;
  private rng: Rng;
  private counter = 0;
  private output: InputState = { x: 0, y: 0, kick: false };
  private aimY = 0;
  private side = 1;
  /** Forces a role (e.g. a goalkeeper-only training bot). */
  roleOverride: Role | null = null;

  constructor(id: number, difficulty: BotDifficulty, seed: number) {
    this.id = id;
    this.difficulty = difficulty;
    this.rng = new Rng(seed ^ (id * 0x9e3779b1));
    this.counter = id % 4;
  }

  think(sim: GameSimulation): InputState {
    const me = sim.getPlayer(this.id);
    if (!me) return { x: 0, y: 0, kick: false };
    const params = PARAMS[this.difficulty];
    const phase = sim.match.phase;
    if (phase === PHASE_COUNTDOWN || phase === PHASE_RESETTING) {
      this.output = { x: 0, y: 0, kick: false };
      return this.output;
    }
    // Release kick right after it latched so the next press re-arms.
    if (me.kickLatch && this.output.kick) this.output = { ...this.output, kick: false };
    if (this.counter-- > 0) return this.output;
    this.counter = params.thinkInterval - 1;
    this.output = this.decide(sim, me, params);
    return this.output;
  }

  private role(sim: GameSimulation, me: SimPlayer): Role {
    const mates = sim.players.filter((p) => p.team === me.team);
    if (mates.length <= 1) return 'attacker';
    const ball = sim.ball;
    let closest = mates[0]!;
    let best = Infinity;
    for (const p of mates) {
      const d = Math.hypot(p.body.x - ball.x, p.body.y - ball.y);
      if (d < best) {
        best = d;
        closest = p;
      }
    }
    if (closest === me) return 'attacker';
    const attack = me.team === TEAM_RED ? 1 : -1;
    let deepest = mates[0]!;
    for (const p of mates) if (p !== closest && p.body.x * attack < deepest.body.x * attack) deepest = p;
    if (deepest === closest) deepest = mates.find((p) => p !== closest)!;
    return deepest === me ? 'keeper' : 'support';
  }

  private decide(sim: GameSimulation, me: SimPlayer, params: BotParams): InputState {
    const map = sim.map;
    const ball = sim.ball;
    const b = me.body;
    const attack = me.team === TEAM_RED ? 1 : -1;
    const W = map.halfWidth;
    const G = map.goalHalfWidth;
    const reach = b.radius + ball.radius;

    // Lead the ball slightly.
    const distToBall = Math.hypot(ball.x - b.x, ball.y - b.y);
    const lead = Math.min(0.5, distToBall / 500);
    const bx = ball.x + ball.vx * lead;
    const by = ball.y + ball.vy * lead;

    let role = this.roleOverride ?? this.role(sim, me);
    if (role === 'keeper' && distToBall < 160 && ball.x * attack < 0) role = 'attacker';

    let tx: number;
    let ty: number;
    let kick = false;

    if (role === 'attacker') {
      if (this.rng.next() < 0.05) this.aimY = (this.rng.next() * 2 - 1) * G * params.aimSpread;
      const gx = attack * (W + 20);
      const gy = this.aimY;
      let dx = gx - bx;
      let dy = gy - by;
      const dl = Math.hypot(dx, dy) || 1;
      dx /= dl;
      dy /= dl;
      // Where I am relative to the ball along the shooting line.
      const rx = b.x - bx;
      const ry = b.y - by;
      const along = rx * dx + ry * dy;
      const lateral = rx * -dy + ry * dx;
      if (along > -reach * 0.6) {
        // In front of the ball: circle around it on the side I'm already on.
        this.side = lateral >= 0 ? 1 : -1;
        tx = bx - dx * (reach + 26) + -dy * this.side * (reach + 22);
        ty = by - dy * (reach + 26) + dx * this.side * (reach + 22);
      } else {
        const toBallX = (bx - b.x) / (distToBall || 1);
        const toBallY = (by - b.y) / (distToBall || 1);
        const align = toBallX * dx + toBallY * dy;
        if (align > params.shootAlignment - 0.25) {
          // Lined up: drive through the ball.
          tx = bx + dx * 30;
          ty = by + dy * 30;
        } else {
          tx = bx - dx * (reach + 6);
          ty = by - dy * (reach + 6);
        }
        // Hold kick while closing in, like a human: the simulation fires the
        // kick on the first tick the ball is within reach.
        const gap = distToBall - reach;
        kick = gap < sim.physics.kickRadius + 40 && align > params.shootAlignment;
      }
      // Emergency clearance: ball close to my own goal, just hit it away.
      if (ball.x * attack < -W * 0.7 && distToBall < reach + sim.physics.kickRadius + 2 && (ball.x - b.x) * attack > 0) kick = true;
    } else if (role === 'keeper') {
      const ox = -attack * W;
      const vx = bx - ox;
      const vy = by;
      const vl = Math.hypot(vx, vy) || 1;
      const guard = G * 0.9;
      tx = ox + (vx / vl) * guard;
      ty = Math.max(-G * 0.85, Math.min(G * 0.85, (vy / vl) * guard));
    } else {
      tx = bx - attack * 220;
      ty = by * -0.4;
      tx = Math.max(-W * 0.85, Math.min(W * 0.85, tx));
    }

    // Arrive steering: aim at the target, compensate current velocity.
    let sx = tx - (b.x + b.vx * 0.22);
    let sy = ty - (b.y + b.vy * 0.22);
    const sl = Math.hypot(sx, sy);
    if (sl < 4) {
      sx = 0;
      sy = 0;
    } else {
      sx /= sl;
      sy /= sl;
      sx += (this.rng.next() * 2 - 1) * params.jitter;
      sy += (this.rng.next() * 2 - 1) * params.jitter;
      const l2 = Math.hypot(sx, sy) || 1;
      const mag = Math.min(1, sl / 40) * params.effort;
      sx = (sx / l2) * mag;
      sy = (sy / l2) * mag;
    }
    return { x: Math.round(sx * AXIS_MAX), y: Math.round(sy * AXIS_MAX), kick };
  }
}
