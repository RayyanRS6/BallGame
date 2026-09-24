/** A tick-loop wake-up later than this counts as a stall. */
export const STALL_MS = 25;

/** Lightweight in-process metrics (no external dependency). */
export class Metrics {
  readonly startedAt = Date.now();
  connections = 0;
  connectionsTotal = 0;
  messagesIn = 0;
  messagesOut = 0;
  bytesIn = 0;
  bytesOut = 0;
  invalidPackets = 0;
  rateLimited = 0;
  goals = 0;
  matchesCompleted = 0;

  private tickSamples = 0;
  private tickTotalMs = 0;
  private tickMaxMs = 0;
  private netSamples = 0;
  private netTotalMs = 0;
  private netMaxMs = 0;
  private lateSamples = 0;
  private lateTotalMs = 0;
  private lateMaxMs = 0;
  private stallMaxMs = 0;
  private stalls = 0;

  /**
   * How late the tick loop woke up compared to its timer. Sustained lateness
   * means the process is CPU-starved (e.g. a fractional-vCPU instance being
   * throttled) — every player then sees extra ping and bursty snapshots.
   */
  recordLoopLateness(ms: number): void {
    this.lateSamples++;
    this.lateTotalMs += ms;
    if (ms > this.lateMaxMs) this.lateMaxMs = ms;
    if (ms > this.stallMaxMs) this.stallMaxMs = ms;
    if (ms > STALL_MS) this.stalls++;
  }

  /** Stalls since the last call (for periodic warnings); resets its own counters. */
  takeStalls(): { stalls: number; maxLateMs: number } {
    const out = { stalls: this.stalls, maxLateMs: Math.round(this.stallMaxMs) };
    this.stalls = 0;
    this.stallMaxMs = 0;
    return out;
  }

  recordTick(ms: number): void {
    this.tickSamples++;
    this.tickTotalMs += ms;
    if (ms > this.tickMaxMs) this.tickMaxMs = ms;
  }

  recordNetwork(ms: number): void {
    this.netSamples++;
    this.netTotalMs += ms;
    if (ms > this.netMaxMs) this.netMaxMs = ms;
  }

  /** Returns a report and resets the interval aggregates. */
  report(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const mem = process.memoryUsage();
    const out = {
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      connections: this.connections,
      connectionsTotal: this.connectionsTotal,
      messagesIn: this.messagesIn,
      messagesOut: this.messagesOut,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      invalidPackets: this.invalidPackets,
      rateLimited: this.rateLimited,
      goals: this.goals,
      matchesCompleted: this.matchesCompleted,
      tickAvgMs: this.tickSamples ? +(this.tickTotalMs / this.tickSamples).toFixed(4) : 0,
      tickMaxMs: +this.tickMaxMs.toFixed(3),
      ticks: this.tickSamples,
      netAvgMs: this.netSamples ? +(this.netTotalMs / this.netSamples).toFixed(4) : 0,
      netMaxMs: +this.netMaxMs.toFixed(3),
      loopLateAvgMs: this.lateSamples ? +(this.lateTotalMs / this.lateSamples).toFixed(3) : 0,
      loopLateMaxMs: +this.lateMaxMs.toFixed(1),
      memoryRssMb: +(mem.rss / 1048576).toFixed(1),
      memoryHeapMb: +(mem.heapUsed / 1048576).toFixed(1),
      ...extra,
    };
    this.tickSamples = this.tickTotalMs = this.tickMaxMs = 0;
    this.netSamples = this.netTotalMs = this.netMaxMs = 0;
    this.lateSamples = this.lateTotalMs = this.lateMaxMs = 0;
    return out;
  }
}
