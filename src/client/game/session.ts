import type { PhysicsWorld } from '../../shared/physics/world.ts';
import type { RenderFrame } from '../rendering/frame.ts';
import type { GameView } from './game-view.ts';

/**
 * A running game: local match, training, online room or replay. The GameView
 * drives it: `update` with real elapsed time, then `fillFrame` for rendering.
 */
export interface GameSession {
  readonly kind: 'local' | 'online' | 'replay';
  attach(view: GameView): void;
  update(dtMs: number, now: number): void;
  fillFrame(frame: RenderFrame, now: number): void;
  debugLines(): string[];
  /** Escape / gamepad Start. */
  onMenu(): void;
  destroy(): void;
}

/** Previous-tick positions, for smooth rendering between fixed ticks. */
export class PrevPositions {
  private xs = new Map<number, number>();
  private ys = new Map<number, number>();

  capture(world: PhysicsWorld): void {
    this.xs.clear();
    this.ys.clear();
    for (const b of world.bodies) {
      this.xs.set(b.id, b.x);
      this.ys.set(b.id, b.y);
    }
  }

  shift(id: number, dx: number, dy: number): void {
    const x = this.xs.get(id);
    if (x === undefined) return;
    this.xs.set(id, x + dx);
    this.ys.set(id, this.ys.get(id)! + dy);
  }

  lerpX(id: number, cur: number, alpha: number): number {
    const p = this.xs.get(id);
    return p === undefined ? cur : p + (cur - p) * alpha;
  }

  lerpY(id: number, cur: number, alpha: number): number {
    const p = this.ys.get(id);
    return p === undefined ? cur : p + (cur - p) * alpha;
  }

  clear(): void {
    this.xs.clear();
    this.ys.clear();
  }
}

/** Visual correction offsets that decay smoothly after reconciliation. */
export class Smoother {
  private ox = new Map<number, number>();
  private oy = new Map<number, number>();
  snapDistance = 70;
  halfLifeMs = 70;

  add(id: number, dx: number, dy: number): void {
    const x = (this.ox.get(id) ?? 0) + dx;
    const y = (this.oy.get(id) ?? 0) + dy;
    if (Math.hypot(x, y) > this.snapDistance) {
      this.ox.delete(id);
      this.oy.delete(id);
      return;
    }
    this.ox.set(id, x);
    this.oy.set(id, y);
  }

  decay(dtMs: number): void {
    const k = Math.pow(0.5, dtMs / this.halfLifeMs);
    for (const [id, v] of this.ox) {
      const nx = v * k;
      const ny = this.oy.get(id)! * k;
      if (Math.abs(nx) < 0.01 && Math.abs(ny) < 0.01) {
        this.ox.delete(id);
        this.oy.delete(id);
      } else {
        this.ox.set(id, nx);
        this.oy.set(id, ny);
      }
    }
  }

  x(id: number): number {
    return this.ox.get(id) ?? 0;
  }

  y(id: number): number {
    return this.oy.get(id) ?? 0;
  }

  clear(): void {
    this.ox.clear();
    this.oy.clear();
  }
}

/** Counts events per second (ticks, frames). */
export class RateCounter {
  private count = 0;
  private start = 0;
  rate = 0;

  tick(now: number): void {
    this.count++;
    if (!this.start) this.start = now;
    if (now - this.start >= 1000) {
      this.rate = (this.count * 1000) / (now - this.start);
      this.count = 0;
      this.start = now;
    }
  }
}

export function fmt(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}
