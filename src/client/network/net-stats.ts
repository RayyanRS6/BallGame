/**
 * Receive-side network statistics: packet loss (from snapshot sequence gaps),
 * duplicates, out-of-order packets, arrival jitter and bandwidth.
 */
export class NetStats {
  private highestSeq = 0;
  private window: { seq: number }[] = [];
  received = 0;
  duplicates = 0;
  outOfOrder = 0;
  /** Loss over the last ~5 seconds, 0..1. */
  loss = 0;
  /** Snapshot inter-arrival jitter (RFC 3550 style), ms. */
  arrivalJitter = 0;
  private lastArrival = 0;
  private lastServerTime = 0;
  bytesIn = 0;
  bytesOut = 0;
  bandwidthIn = 0;
  bandwidthOut = 0;
  private bwStart = 0;
  private bwIn = 0;
  private bwOut = 0;
  private seen = new Set<number>();

  /** Returns 'ok', 'duplicate' or 'old'. */
  onSnapshot(seq: number, serverTime: number, arrival: number, bytes: number): 'ok' | 'duplicate' | 'old' {
    this.bytesIn += bytes;
    this.bwIn += bytes;
    if (this.seen.has(seq)) {
      this.duplicates++;
      return 'duplicate';
    }
    this.seen.add(seq);
    if (this.seen.size > 512) {
      const min = seq - 400;
      for (const s of this.seen) if (s < min) this.seen.delete(s);
    }
    this.received++;
    this.window.push({ seq });
    if (this.window.length > 300) this.window.shift();
    if (seq < this.highestSeq) {
      this.outOfOrder++;
      return 'old';
    }
    if (this.lastArrival) {
      const d = arrival - this.lastArrival - (serverTime - this.lastServerTime);
      this.arrivalJitter += (Math.abs(d) - this.arrivalJitter) / 16;
    }
    this.lastArrival = arrival;
    this.lastServerTime = serverTime;
    this.highestSeq = seq;
    const first = this.window[0]!.seq;
    const expected = this.highestSeq - first + 1;
    this.loss = expected > 0 ? Math.max(0, 1 - this.window.length / expected) : 0;
    return 'ok';
  }

  onSend(bytes: number): void {
    this.bytesOut += bytes;
    this.bwOut += bytes;
  }

  onReceiveOther(bytes: number): void {
    this.bytesIn += bytes;
    this.bwIn += bytes;
  }

  update(now: number): void {
    if (!this.bwStart) this.bwStart = now;
    const dt = now - this.bwStart;
    if (dt >= 1000) {
      this.bandwidthIn = (this.bwIn * 1000) / dt;
      this.bandwidthOut = (this.bwOut * 1000) / dt;
      this.bwIn = this.bwOut = 0;
      this.bwStart = now;
    }
  }

  reset(): void {
    this.highestSeq = 0;
    this.window.length = 0;
    this.seen.clear();
    this.loss = 0;
    this.lastArrival = 0;
    this.arrivalJitter = 0;
  }
}
