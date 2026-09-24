import type { InputState } from '../../shared/types/index.ts';

export type PushResult = 'ok' | 'stale' | 'duplicate' | 'invalid';

const NEUTRAL: InputState = Object.freeze({ x: 0, y: 0, kick: false });

/** Inputs may arrive at most this many ticks ahead of the last consumed one. */
const MAX_AHEAD = 600;
const SOFT_MAX_DEPTH = 6;
const DEEP_TICKS_BEFORE_SKIP = 20;

/**
 * Per-player jitter buffer. The server consumes **exactly one input per
 * tick**, so a client can never move faster by sending more inputs (they are
 * simply dropped when the queue overflows) — the core of the anti-speedhack
 * design. When the queue runs dry the last input is repeated for a few ticks
 * (hides short hiccups) and then replaced by a neutral input.
 */
export class InputBuffer {
  private queue: { seq: number; input: InputState }[] = [];
  lastProcessed = 0;
  lastReceived = 0;
  private last: InputState = NEUTRAL;
  private starved = 0;
  private deepTicks = 0;
  /** Inputs dropped because the queue overflowed. */
  overflowed = 0;
  /** Ticks during which no fresh input was available. */
  starvedTotal = 0;
  readonly maxQueue: number;
  readonly repeatLimit: number;

  constructor(maxQueue = 12, repeatLimit = 8) {
    this.maxQueue = maxQueue;
    this.repeatLimit = repeatLimit;
  }

  get depth(): number {
    return this.queue.length;
  }

  push(seq: number, input: InputState): PushResult {
    if (!Number.isInteger(seq) || seq <= 0) return 'invalid';
    if (seq <= this.lastProcessed) return 'stale';
    if (seq > this.lastProcessed + MAX_AHEAD) return 'invalid';
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1]!.seq > seq) i--;
    if (i > 0 && this.queue[i - 1]!.seq === seq) return 'duplicate';
    this.queue.splice(i, 0, { seq, input: { x: input.x, y: input.y, kick: input.kick } });
    if (seq > this.lastReceived) this.lastReceived = seq;
    while (this.queue.length > this.maxQueue) {
      const dropped = this.queue.shift()!;
      this.lastProcessed = dropped.seq;
      this.last = dropped.input;
      this.overflowed++;
    }
    return 'ok';
  }

  /** Returns the input to apply this tick. */
  consume(): InputState {
    // A persistently deep queue only adds latency (e.g. after a burst from a
    // stalled tab). Drain it slowly by skipping one input now and then.
    if (this.queue.length > SOFT_MAX_DEPTH) {
      if (++this.deepTicks >= DEEP_TICKS_BEFORE_SKIP && this.queue.length > 1) {
        const skipped = this.queue.shift()!;
        this.lastProcessed = skipped.seq;
        this.deepTicks = 0;
        this.overflowed++;
      }
    } else {
      this.deepTicks = 0;
    }
    const next = this.queue.shift();
    if (next) {
      this.lastProcessed = next.seq;
      this.last = next.input;
      this.starved = 0;
      return next.input;
    }
    this.starved++;
    this.starvedTotal++;
    return this.starved > this.repeatLimit ? NEUTRAL : this.last;
  }

  /** Called on (re)connection: sequence numbering restarts from 1. */
  reset(): void {
    this.queue.length = 0;
    this.lastProcessed = 0;
    this.lastReceived = 0;
    this.last = NEUTRAL;
    this.starved = 0;
    this.deepTicks = 0;
  }
}
