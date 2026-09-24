/**
 * Deterministic 2D impulse-based physics for discs, segments, planes and
 * static circles.
 *
 * Determinism rules followed throughout this file:
 *  - only IEEE-754 exact operations (+ − × ÷ and Math.sqrt) — no trig/exp;
 *  - bodies and colliders are processed in array order (bodies sorted by id);
 *  - no allocation in the hot loop, no Math.random.
 *
 * Integration is semi-implicit Euler with a fixed step `h`. Each step is split
 * into adaptive micro-steps so no body moves more than ~45% of its radius per
 * micro-step (continuous collision safety against thin walls), and contacts are
 * resolved with sequential impulses plus full positional correction.
 */

export interface Body {
  /** Stable identifier; also defines deterministic processing order. */
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Angular velocity (rad/s, +z). Only meaningful when invInertia > 0. */
  w: number;
  radius: number;
  invMass: number;
  invInertia: number;
  restitution: number;
  /** Coulomb friction coefficient at contacts (0 = frictionless). */
  friction: number;
  /** Linear drag (1/s). */
  drag: number;
  /** Quadratic drag (1/u). */
  airDrag: number;
  /** Magnus coefficient (curve from spin). */
  magnus: number;
  spinDamping: number;
  maxSpin: number;
  maxSpeed: number;
  /** Acceleration applied during the next step (u/s²). */
  ax: number;
  ay: number;
  /** Collision category bits of this body. */
  category: number;
  /** Categories this body collides with. */
  mask: number;
  /** When true the body is excluded from integration and collision. */
  frozen: boolean;
}

export interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  dx: number;
  dy: number;
  invLenSq: number;
  /** Fallback normal (left-hand) used when a centre lies exactly on the segment. */
  nx: number;
  ny: number;
  restitution: number;
  friction: number;
  mask: number;
  tag: number;
  enabled: boolean;
}

/** Half-space constraint: nx·x + ny·y ≥ d + radius. The normal points inward. */
export interface Plane {
  nx: number;
  ny: number;
  d: number;
  restitution: number;
  friction: number;
  mask: number;
  tag: number;
  enabled: boolean;
}

export interface StaticCircle {
  x: number;
  y: number;
  radius: number;
  restitution: number;
  friction: number;
  mask: number;
  tag: number;
  enabled: boolean;
}

/**
 * Contact callback. `b` is null for static colliders (then `tag` identifies the
 * collider). `approachSpeed` is the closing speed along the normal before the
 * impulse (≥ 0).
 */
export type ContactListener = (a: Body, b: Body | null, tag: number, x: number, y: number, nx: number, ny: number, approachSpeed: number) => void;

export function createBody(id: number): Body {
  return {
    id,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    w: 0,
    radius: 10,
    invMass: 1,
    invInertia: 0,
    restitution: 0.5,
    friction: 0,
    drag: 0,
    airDrag: 0,
    magnus: 0,
    spinDamping: 0,
    maxSpin: 0,
    maxSpeed: 1e9,
    ax: 0,
    ay: 0,
    category: 0,
    mask: 0,
    frozen: false,
  };
}

export function createSegment(ax: number, ay: number, bx: number, by: number, restitution: number, friction: number, mask: number, tag: number): Segment {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const len = Math.sqrt(lenSq);
  return {
    ax,
    ay,
    bx,
    by,
    dx,
    dy,
    invLenSq: lenSq > 0 ? 1 / lenSq : 0,
    nx: len > 0 ? -dy / len : 0,
    ny: len > 0 ? dx / len : 1,
    restitution,
    friction,
    mask,
    tag,
    enabled: true,
  };
}

const MAX_MICRO_STEPS = 16;
const MICRO_STEP_FRACTION = 0.45;
export const MAX_DEBUG_CONTACTS = 64;

export class PhysicsWorld {
  bodies: Body[] = [];
  segments: Segment[] = [];
  planes: Plane[] = [];
  circles: StaticCircle[] = [];
  iterations = 2;
  onContact: ContactListener | null = null;

  /** Debug: contact points of the last step as [x, y, nx, ny] quadruples. */
  recordContacts = false;
  readonly debugContacts = new Float64Array(MAX_DEBUG_CONTACTS * 4);
  debugContactCount = 0;
  /** Number of impulse-producing contacts during the last step. */
  collisionCount = 0;
  /** Micro-steps used in the last step (diagnostics). */
  lastMicroSteps = 1;

  addBody(body: Body): void {
    this.bodies.push(body);
    this.bodies.sort((a, b) => a.id - b.id);
  }

  removeBody(body: Body): void {
    const i = this.bodies.indexOf(body);
    if (i >= 0) this.bodies.splice(i, 1);
  }

  /** Advances the world by `h` seconds. */
  step(h: number): void {
    this.debugContactCount = 0;
    this.collisionCount = 0;
    const bodies = this.bodies;
    const n = bodies.length;

    // 1. Velocity integration: acceleration, curve, drag, safety clamps.
    for (let i = 0; i < n; i++) {
      const b = bodies[i]!;
      if (b.frozen) continue;
      let vx = b.vx + b.ax * h;
      let vy = b.vy + b.ay * h;

      if (b.magnus !== 0 && b.w !== 0) {
        // Rotate velocity by the Magnus turn rate; renormalise so curving
        // never adds kinetic energy.
        const k = b.magnus * b.w * h;
        const s = 1 / Math.sqrt(1 + k * k);
        const nvx = (vx - k * vy) * s;
        const nvy = (vy + k * vx) * s;
        vx = nvx;
        vy = nvy;
      }

      let f = 1 - b.drag * h;
      if (b.airDrag > 0) f -= b.airDrag * Math.sqrt(vx * vx + vy * vy) * h;
      if (f < 0) f = 0;
      vx *= f;
      vy *= f;

      const sp2 = vx * vx + vy * vy;
      if (sp2 > b.maxSpeed * b.maxSpeed) {
        const s = b.maxSpeed / Math.sqrt(sp2);
        vx *= s;
        vy *= s;
      }
      b.vx = vx;
      b.vy = vy;

      if (b.invInertia > 0) {
        let w = b.w * (1 - b.spinDamping * h);
        if (w > b.maxSpin) w = b.maxSpin;
        else if (w < -b.maxSpin) w = -b.maxSpin;
        b.w = w;
      } else {
        b.w = 0;
      }
    }

    // 2. Adaptive micro-steps (continuous collision safety).
    let micro = 1;
    for (let i = 0; i < n; i++) {
      const b = bodies[i]!;
      if (b.frozen) continue;
      const limit = (MICRO_STEP_FRACTION * b.radius) / h;
      const sp2 = b.vx * b.vx + b.vy * b.vy;
      if (sp2 > limit * limit) {
        const need = Math.ceil(Math.sqrt(sp2) / limit);
        if (need > micro) micro = need;
      }
    }
    if (micro > MAX_MICRO_STEPS) micro = MAX_MICRO_STEPS;
    this.lastMicroSteps = micro;
    const hs = h / micro;

    for (let m = 0; m < micro; m++) {
      for (let i = 0; i < n; i++) {
        const b = bodies[i]!;
        if (b.frozen) continue;
        b.x += b.vx * hs;
        b.y += b.vy * hs;
      }
      this.solve();
    }
  }

  /** Resolves all contacts. Walls are solved last so nothing ends inside them. */
  solve(): void {
    const bodies = this.bodies;
    const n = bodies.length;
    for (let it = 0; it < this.iterations; it++) {
      for (let i = 0; i < n; i++) {
        const a = bodies[i]!;
        if (a.frozen) continue;
        for (let j = i + 1; j < n; j++) {
          const b = bodies[j]!;
          if (b.frozen) continue;
          if ((a.mask & b.category) === 0 || (b.mask & a.category) === 0) continue;
          this.collideBodies(a, b);
        }
      }
      for (let i = 0; i < n; i++) {
        const b = bodies[i]!;
        if (b.frozen) continue;
        const segs = this.segments;
        for (let s = 0; s < segs.length; s++) {
          const seg = segs[s]!;
          if (seg.enabled && (seg.mask & b.category) !== 0) this.collideSegment(b, seg);
        }
        const circles = this.circles;
        for (let c = 0; c < circles.length; c++) {
          const sc = circles[c]!;
          if (sc.enabled && (sc.mask & b.category) !== 0) this.collideStaticCircle(b, sc);
        }
        const planes = this.planes;
        for (let p = 0; p < planes.length; p++) {
          const pl = planes[p]!;
          if (pl.enabled && (pl.mask & b.category) !== 0) this.collidePlane(b, pl);
        }
      }
    }
  }

  private recordContact(x: number, y: number, nx: number, ny: number): void {
    this.collisionCount++;
    if (!this.recordContacts || this.debugContactCount >= MAX_DEBUG_CONTACTS) return;
    const k = this.debugContactCount * 4;
    this.debugContacts[k] = x;
    this.debugContacts[k + 1] = y;
    this.debugContacts[k + 2] = nx;
    this.debugContacts[k + 3] = ny;
    this.debugContactCount++;
  }

  collideBodies(a: Body, b: Body): void {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const rSum = a.radius + b.radius;
    const distSq = dx * dx + dy * dy;
    if (distSq >= rSum * rSum) return;
    const invSum = a.invMass + b.invMass;
    if (invSum === 0) return;

    let nx: number;
    let ny: number;
    let dist: number;
    if (distSq > 0) {
      dist = Math.sqrt(distSq);
      nx = dx / dist;
      ny = dy / dist;
    } else {
      // Perfectly coincident centres: separate along +x (deterministic).
      dist = 0;
      nx = 1;
      ny = 0;
    }

    // Positional correction, split by inverse mass.
    const pen = rSum - dist;
    const corr = pen / invSum;
    a.x -= nx * corr * a.invMass;
    a.y -= ny * corr * a.invMass;
    b.x += nx * corr * b.invMass;
    b.y += ny * corr * b.invMass;

    const rvx = b.vx - a.vx;
    const rvy = b.vy - a.vy;
    const vn = rvx * nx + rvy * ny;
    if (vn >= 0) return; // already separating

    const e = a.restitution * b.restitution;
    const jn = (-(1 + e) * vn) / invSum;
    a.vx -= jn * nx * a.invMass;
    a.vy -= jn * ny * a.invMass;
    b.vx += jn * nx * b.invMass;
    b.vy += jn * ny * b.invMass;

    const px = a.x + nx * a.radius;
    const py = a.y + ny * a.radius;

    // Tangential friction (spin transfer) when either body can rotate.
    const mu = a.friction > b.friction ? a.friction : b.friction;
    if (mu > 0 && (a.invInertia > 0 || b.invInertia > 0)) {
      const tx = -ny;
      const ty = nx;
      const vt = (b.vx - a.vx) * tx + (b.vy - a.vy) * ty - b.w * b.radius - a.w * a.radius;
      const k = invSum + a.radius * a.radius * a.invInertia + b.radius * b.radius * b.invInertia;
      let jt = -vt / k;
      const maxJt = mu * jn;
      if (jt > maxJt) jt = maxJt;
      else if (jt < -maxJt) jt = -maxJt;
      a.vx -= jt * tx * a.invMass;
      a.vy -= jt * ty * a.invMass;
      b.vx += jt * tx * b.invMass;
      b.vy += jt * ty * b.invMass;
      a.w -= a.invInertia * jt * a.radius;
      b.w -= b.invInertia * jt * b.radius;
    }

    this.recordContact(px, py, nx, ny);
    if (this.onContact) this.onContact(a, b, 0, px, py, nx, ny, -vn);
  }

  /** Resolves a body against a static surface with inward normal (nx, ny). */
  private resolveStatic(b: Body, nx: number, ny: number, pen: number, restitution: number, friction: number, tag: number): void {
    b.x += nx * pen;
    b.y += ny * pen;
    const vn = b.vx * nx + b.vy * ny;
    if (vn >= 0) return;
    const e = b.restitution * restitution;
    const dv = -(1 + e) * vn;
    b.vx += dv * nx;
    b.vy += dv * ny;

    const mu = b.friction > friction ? b.friction : friction;
    if (mu > 0 && b.invInertia > 0 && b.invMass > 0) {
      // Contact point is at -n·r from the centre.
      const tx = -ny;
      const ty = nx;
      const vt = b.vx * tx + b.vy * ty - b.w * b.radius;
      const k = b.invMass + b.radius * b.radius * b.invInertia;
      let jt = -vt / k;
      const jn = dv / b.invMass;
      const maxJt = mu * jn;
      if (jt > maxJt) jt = maxJt;
      else if (jt < -maxJt) jt = -maxJt;
      b.vx += jt * tx * b.invMass;
      b.vy += jt * ty * b.invMass;
      b.w -= b.invInertia * jt * b.radius;
    }

    const px = b.x - nx * b.radius;
    const py = b.y - ny * b.radius;
    this.recordContact(px, py, nx, ny);
    if (this.onContact) this.onContact(b, null, tag, px, py, nx, ny, -vn);
  }

  collideSegment(b: Body, s: Segment): void {
    let t = ((b.x - s.ax) * s.dx + (b.y - s.ay) * s.dy) * s.invLenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const cx = s.ax + s.dx * t;
    const cy = s.ay + s.dy * t;
    const dx = b.x - cx;
    const dy = b.y - cy;
    const distSq = dx * dx + dy * dy;
    const r = b.radius;
    if (distSq >= r * r) return;
    let nx: number;
    let ny: number;
    let dist: number;
    if (distSq > 0) {
      dist = Math.sqrt(distSq);
      nx = dx / dist;
      ny = dy / dist;
    } else {
      dist = 0;
      nx = s.nx;
      ny = s.ny;
    }
    this.resolveStatic(b, nx, ny, r - dist, s.restitution, s.friction, s.tag);
  }

  collidePlane(b: Body, p: Plane): void {
    const dist = b.x * p.nx + b.y * p.ny - p.d;
    if (dist >= b.radius) return;
    this.resolveStatic(b, p.nx, p.ny, b.radius - dist, p.restitution, p.friction, p.tag);
  }

  collideStaticCircle(b: Body, c: StaticCircle): void {
    const dx = b.x - c.x;
    const dy = b.y - c.y;
    const rSum = b.radius + c.radius;
    const distSq = dx * dx + dy * dy;
    if (distSq >= rSum * rSum) return;
    let nx: number;
    let ny: number;
    let dist: number;
    if (distSq > 0) {
      dist = Math.sqrt(distSq);
      nx = dx / dist;
      ny = dy / dist;
    } else {
      dist = 0;
      nx = 1;
      ny = 0;
    }
    this.resolveStatic(b, nx, ny, rSum - dist, c.restitution, c.friction, c.tag);
  }
}
