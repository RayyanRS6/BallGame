interface ClockSample {
  rtt: number;
  offset: number;
}

const WINDOW = 12;

/**
 * NTP-style clock synchronisation:
 *   client sends t0 → server replies with its time ts → client receives at t1
 *   rtt = t1 − t0, offset ≈ ts + rtt/2 − t1
 * The sample with the lowest RTT in a sliding window is the least affected by
 * queueing delay, so it is used as the offset estimate; changes are slewed
 * gradually to avoid visible jumps.
 */
export class ClockSync {
  private samples: ClockSample[] = [];
  private offset = 0;
  private target = 0;
  private hasSample = false;
  rtt = 0;
  /** Smoothed RTT (EWMA). */
  srtt = 0;
  /** Mean RTT deviation (jitter). */
  jitter = 0;

  addSample(clientSend: number, serverTime: number, clientReceive: number): void {
    const rtt = Math.max(0, clientReceive - clientSend);
    const offset = serverTime + rtt / 2 - clientReceive;
    this.samples.push({ rtt, offset });
    if (this.samples.length > WINDOW) this.samples.shift();
    let best = this.samples[0]!;
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;
    this.target = best.offset;
    if (!this.hasSample) {
      this.offset = this.target;
      this.srtt = rtt;
      this.hasSample = true;
    } else {
      this.jitter += (Math.abs(rtt - this.srtt) - this.jitter) * 0.2;
      this.srtt += (rtt - this.srtt) * 0.15;
    }
    this.rtt = rtt;
  }

  /** Call once per frame: slews the offset towards the estimate. */
  update(dtMs: number): void {
    const diff = this.target - this.offset;
    if (Math.abs(diff) > 250) this.offset = this.target; // large correction: snap
    else this.offset += diff * Math.min(1, dtMs / 500);
  }

  get synced(): boolean {
    return this.hasSample;
  }

  /** Estimated current server time (ms). */
  serverNow(clientNow: number = performance.now()): number {
    return clientNow + this.offset;
  }

  reset(): void {
    this.samples.length = 0;
    this.hasSample = false;
    this.offset = this.target = 0;
    this.rtt = this.srtt = this.jitter = 0;
  }
}
