/** Classic token bucket: `capacity` burst, refilled at `ratePerSec`. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  readonly capacity: number;
  readonly ratePerSec: number;

  constructor(capacity: number, ratePerSec: number, now: number) {
    this.capacity = capacity;
    this.ratePerSec = ratePerSec;
    this.tokens = capacity;
    this.last = now;
  }

  take(now: number, cost = 1): boolean {
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerSec);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/** Tracks concurrent connections per IP address. */
export class ConnectionLimiter {
  private counts = new Map<string, number>();
  readonly perIp: number;

  constructor(perIp: number) {
    this.perIp = perIp;
  }

  acquire(ip: string): boolean {
    const n = this.counts.get(ip) ?? 0;
    if (n >= this.perIp) return false;
    this.counts.set(ip, n + 1);
    return true;
  }

  release(ip: string): void {
    const n = (this.counts.get(ip) ?? 1) - 1;
    if (n <= 0) this.counts.delete(ip);
    else this.counts.set(ip, n);
  }
}
