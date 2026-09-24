/**
 * Keeps the client's input clock slightly ahead of the server.
 *
 * The server reports how many of our inputs are buffered after each tick. If
 * the buffer runs dry the server has to guess our input (causing prediction
 * errors); if it grows, our inputs wait too long (added latency). The client
 * therefore runs its tick clock a few percent faster or slower to hold the
 * buffer near a small target that grows with measured jitter.
 */
export class TimeDilation {
  private depthAvg = -1;
  target = 2;
  /** Multiplier applied to the client tick rate. */
  scale = 1;

  onSnapshot(queueDepth: number, jitterMs: number, tickMs: number): void {
    this.depthAvg = this.depthAvg < 0 ? queueDepth : this.depthAvg + (queueDepth - this.depthAvg) * 0.08;
    this.target = Math.min(8, Math.max(1.5, 1.2 + (2 * jitterMs) / tickMs));
    const err = this.target - this.depthAvg;
    this.scale = Math.min(1.06, Math.max(0.94, 1 + err * 0.015));
  }

  get averageDepth(): number {
    return Math.max(0, this.depthAvg);
  }

  reset(): void {
    this.depthAvg = -1;
    this.scale = 1;
  }
}
