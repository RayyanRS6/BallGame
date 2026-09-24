/**
 * Simulates an imperfect network link: latency, jitter, packet loss,
 * duplication and reordering. Used by automated network tests and by the
 * in-game "network simulator" developer setting.
 *
 * Messages flagged `reliable` (control messages) are never dropped,
 * duplicated or reordered — like a reliable channel. Unreliable messages
 * (inputs, snapshots, pings) get the full treatment, which models a datagram
 * transport such as WebTransport/WebRTC and stress-tests the recovery logic.
 */
export interface LinkConditions {
  latencyMs: number;
  jitterMs: number;
  lossRate: number;
  duplicateRate: number;
  reorder: boolean;
}

export const PERFECT_LINK: LinkConditions = { latencyMs: 0, jitterMs: 0, lossRate: 0, duplicateRate: 0, reorder: false };

interface Pending<T> {
  at: number;
  order: number;
  msg: T;
}

export class LinkSimulator<T> {
  conditions: LinkConditions;
  private queue: Pending<T>[] = [];
  private lastReliableAt = 0;
  private lastUnreliableAt = 0;
  private order = 0;
  private random: () => number;
  sent = 0;
  dropped = 0;
  duplicated = 0;

  constructor(conditions: LinkConditions, random: () => number = Math.random) {
    this.conditions = { ...conditions };
    this.random = random;
  }

  get idle(): boolean {
    return this.conditions.latencyMs <= 0 && this.conditions.jitterMs <= 0 && this.conditions.lossRate <= 0 && this.conditions.duplicateRate <= 0;
  }

  get pending(): number {
    return this.queue.length;
  }

  send(msg: T, now: number, reliable: boolean): void {
    const c = this.conditions;
    this.sent++;
    if (!reliable && c.lossRate > 0 && this.random() < c.lossRate) {
      this.dropped++;
      return;
    }
    const jitter = c.jitterMs > 0 ? (this.random() * 2 - 1) * c.jitterMs : 0;
    let at = now + Math.max(0, c.latencyMs + jitter);
    if (reliable) {
      at = Math.max(at, this.lastReliableAt);
      this.lastReliableAt = at;
    } else if (!c.reorder) {
      at = Math.max(at, this.lastUnreliableAt);
      this.lastUnreliableAt = at;
    }
    this.insert(at, msg);
    if (!reliable && c.duplicateRate > 0 && this.random() < c.duplicateRate) {
      this.duplicated++;
      this.insert(at + this.random() * Math.max(1, c.jitterMs), msg);
    }
  }

  private insert(at: number, msg: T): void {
    const item = { at, order: this.order++, msg };
    let i = this.queue.length;
    while (i > 0 && (this.queue[i - 1]!.at > at || (this.queue[i - 1]!.at === at && this.queue[i - 1]!.order > item.order))) i--;
    this.queue.splice(i, 0, item);
  }

  /** Delivers every message due at `now`, in delivery order. */
  poll(now: number, deliver: (msg: T) => void): void {
    while (this.queue.length > 0 && this.queue[0]!.at <= now) deliver(this.queue.shift()!.msg);
  }

  clear(): void {
    this.queue.length = 0;
  }
}
