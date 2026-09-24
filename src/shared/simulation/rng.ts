/**
 * Seeded 32-bit PRNG (mulberry32). Integer-only arithmetic, so the sequence is
 * identical on every JavaScript engine. The whole generator state is a single
 * uint32, which makes it trivial to snapshot and replay.
 */
export class Rng {
  state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  nextU32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
}

/** Derives a well-mixed seed from arbitrary numbers (e.g. time + counter). */
export function mixSeed(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h ^= p >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= Math.floor(p / 4294967296) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
