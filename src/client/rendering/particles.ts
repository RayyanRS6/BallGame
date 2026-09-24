/**
 * Fixed-capacity particle system stored as a structure of arrays: no
 * allocation after construction, no GC pressure during play. Purely visual —
 * it never feeds back into the simulation.
 */
export class Particles {
  readonly capacity: number;
  private x: Float32Array;
  private y: Float32Array;
  private vx: Float32Array;
  private vy: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private size: Float32Array;
  private drag: Float32Array;
  private color: string[];
  private count = 0;
  /** Global multiplier (reduced motion / quality). */
  density = 1;

  constructor(capacity = 700) {
    this.capacity = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.color = new Array<string>(capacity).fill('#fff');
  }

  emit(x: number, y: number, vx: number, vy: number, life: number, size: number, color: string, drag = 3): void {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.drag[i] = drag;
    this.color[i] = color;
  }

  /** Radial burst. `dirX/dirY` bias the direction (0,0 = uniform). */
  burst(x: number, y: number, n: number, speed: number, color: string, opts: { dirX?: number; dirY?: number; spread?: number; life?: number; size?: number } = {}): void {
    const count = Math.round(n * this.density);
    const spread = opts.spread ?? Math.PI;
    const base = opts.dirX || opts.dirY ? Math.atan2(opts.dirY ?? 0, opts.dirX ?? 0) : 0;
    for (let k = 0; k < count; k++) {
      const a = opts.dirX || opts.dirY ? base + (Math.random() * 2 - 1) * spread : Math.random() * Math.PI * 2;
      const s = speed * (0.35 + Math.random() * 0.65);
      this.emit(x, y, Math.cos(a) * s, Math.sin(a) * s, (opts.life ?? 0.45) * (0.6 + Math.random() * 0.6), (opts.size ?? 2.5) * (0.6 + Math.random() * 0.8), color);
    }
  }

  update(dt: number): void {
    let i = 0;
    while (i < this.count) {
      this.life[i]! -= dt;
      if (this.life[i]! <= 0) {
        // Swap-remove keeps the arrays dense.
        const j = --this.count;
        this.x[i] = this.x[j]!;
        this.y[i] = this.y[j]!;
        this.vx[i] = this.vx[j]!;
        this.vy[i] = this.vy[j]!;
        this.life[i] = this.life[j]!;
        this.maxLife[i] = this.maxLife[j]!;
        this.size[i] = this.size[j]!;
        this.drag[i] = this.drag[j]!;
        this.color[i] = this.color[j]!;
        continue;
      }
      const f = Math.max(0, 1 - this.drag[i]! * dt);
      this.vx[i]! *= f;
      this.vy[i]! *= f;
      this.x[i]! += this.vx[i]! * dt;
      this.y[i]! += this.vy[i]! * dt;
      i++;
    }
  }

  draw(ctx: CanvasRenderingContext2D, sx: (x: number) => number, sy: (y: number) => number, scale: number): void {
    for (let i = 0; i < this.count; i++) {
      const t = this.life[i]! / this.maxLife[i]!;
      ctx.globalAlpha = Math.min(1, t * 1.5);
      ctx.fillStyle = this.color[i]!;
      const r = Math.max(0.6, this.size[i]! * scale * (0.5 + 0.5 * t));
      ctx.fillRect(sx(this.x[i]!) - r, sy(this.y[i]!) - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
  }

  clear(): void {
    this.count = 0;
  }
}
