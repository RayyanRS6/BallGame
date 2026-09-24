export type ViolationKind =
  | 'malformed_packet'
  | 'unknown_message'
  | 'rate_limited'
  | 'input_flood'
  | 'input_sequence'
  | 'invalid_state_transition'
  | 'oversized_packet';

/** Weight of each violation. The connection is dropped when the score reaches LIMIT. */
const WEIGHTS: Record<ViolationKind, number> = {
  malformed_packet: 10,
  unknown_message: 5,
  rate_limited: 2,
  input_flood: 5,
  input_sequence: 3,
  invalid_state_transition: 1,
  oversized_packet: 25,
};

const LIMIT = 100;
/** Score decays so occasional glitches from honest clients never add up. */
const DECAY_PER_SEC = 2;

/**
 * Server-side suspicion tracker. Clients cannot move bodies directly, so
 * cheating reduces to abusing the protocol — which is what this watches.
 */
export class AbuseTracker {
  private score = 0;
  private last: number;
  readonly counts: Partial<Record<ViolationKind, number>> = {};

  constructor(now: number) {
    this.last = now;
  }

  /** Records a violation; returns true when the client should be disconnected. */
  record(kind: ViolationKind, now: number): boolean {
    this.score = Math.max(0, this.score - ((now - this.last) / 1000) * DECAY_PER_SEC);
    this.last = now;
    this.score += WEIGHTS[kind];
    this.counts[kind] = (this.counts[kind] ?? 0) + 1;
    return this.score >= LIMIT;
  }

  get currentScore(): number {
    return this.score;
  }
}

/**
 * Detects clients sending more inputs than the simulation can consume
 * (speed-hack attempts or broken clients). Inputs beyond the tick rate are
 * dropped by the input buffer anyway; this only flags the behaviour.
 */
export class InputRateMonitor {
  private windowStart: number;
  private count = 0;
  private readonly maxPerSec: number;

  constructor(tickRate: number, now: number) {
    this.maxPerSec = tickRate * 1.5 + 10;
    this.windowStart = now;
  }

  /** Returns true when the rate over the last window was excessive. */
  add(n: number, now: number): boolean {
    this.count += n;
    const elapsed = now - this.windowStart;
    if (elapsed < 2000) return false;
    const rate = (this.count * 1000) / elapsed;
    this.count = 0;
    this.windowStart = now;
    return rate > this.maxPerSec;
  }
}
