import type { SimStateData } from '../../shared/types/index.ts';

export interface InterpBody {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Sample {
  time: number;
  tick: number;
  players: Map<number, InterpBody>;
  ball: InterpBody;
}

export interface InterpResult {
  /** Positions for the requested render time. */
  players: Map<number, InterpBody>;
  ball: InterpBody;
  /** True when the render time was beyond the newest snapshot. */
  extrapolated: boolean;
  /** Fraction between the two bracketing snapshots (debug). */
  alpha: number;
}

const KEEP_MS = 2000;
const MAX_EXTRAPOLATION_MS = 100;

/**
 * Snapshot interpolation buffer for remote entities. Rendering a little in
 * the past (the interpolation delay) means there are almost always two
 * snapshots to blend between, so irregular packet arrival is invisible.
 */
export class InterpolationBuffer {
  private samples: Sample[] = [];
  private out: InterpResult = { players: new Map(), ball: { x: 0, y: 0, vx: 0, vy: 0 }, extrapolated: false, alpha: 0 };

  clear(): void {
    this.samples.length = 0;
  }

  get size(): number {
    return this.samples.length;
  }

  get newestTime(): number {
    return this.samples.length ? this.samples[this.samples.length - 1]!.time : 0;
  }

  push(serverTime: number, state: SimStateData): void {
    const players = new Map<number, InterpBody>();
    for (const p of state.players) players.set(p.id, { x: p.x, y: p.y, vx: p.vx, vy: p.vy });
    const sample: Sample = { time: serverTime, tick: state.tick, players, ball: { ...state.ball } };
    // Insert in time order; drop duplicates.
    let i = this.samples.length;
    while (i > 0 && this.samples[i - 1]!.time > serverTime) i--;
    if (i > 0 && this.samples[i - 1]!.tick === state.tick) return;
    this.samples.splice(i, 0, sample);
    const cutoff = this.newestTime - KEEP_MS;
    while (this.samples.length > 2 && this.samples[0]!.time < cutoff) this.samples.shift();
  }

  sample(renderTime: number): InterpResult | null {
    const s = this.samples;
    if (s.length === 0) return null;
    const out = this.out;
    out.players.clear();
    let a = s[0]!;
    let b = a;
    if (renderTime <= a.time) {
      b = a;
    } else {
      for (let i = s.length - 1; i >= 0; i--) {
        if (s[i]!.time <= renderTime) {
          a = s[i]!;
          b = s[Math.min(i + 1, s.length - 1)]!;
          break;
        }
      }
    }
    if (a === b) {
      // Before the first or after the last snapshot: short extrapolation.
      const dt = Math.max(0, Math.min(MAX_EXTRAPOLATION_MS, renderTime - a.time)) / 1000;
      out.extrapolated = renderTime > a.time;
      out.alpha = 0;
      for (const [id, p] of a.players) out.players.set(id, { x: p.x + p.vx * dt, y: p.y + p.vy * dt, vx: p.vx, vy: p.vy });
      out.ball = { x: a.ball.x + a.ball.vx * dt, y: a.ball.y + a.ball.vy * dt, vx: a.ball.vx, vy: a.ball.vy };
      return out;
    }
    const t = (renderTime - a.time) / (b.time - a.time);
    out.alpha = t;
    out.extrapolated = false;
    for (const [id, pb] of b.players) {
      const pa = a.players.get(id);
      if (!pa) out.players.set(id, { ...pb });
      else out.players.set(id, lerpBody(pa, pb, t));
    }
    out.ball = lerpBody(a.ball, b.ball, t);
    return out;
  }
}

function lerpBody(a: InterpBody, b: InterpBody, t: number): InterpBody {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    vx: a.vx + (b.vx - a.vx) * t,
    vy: a.vy + (b.vy - a.vy) * t,
  };
}
