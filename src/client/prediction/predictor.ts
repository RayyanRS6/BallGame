import { MAX_INPUTS_PER_PACKET, type DecodedSnapshot } from '../../shared/protocol/messages.ts';
import type { GameSimulation } from '../../shared/simulation/simulation.ts';
import type { InputState } from '../../shared/types/index.ts';

export interface PendingInput {
  seq: number;
  input: InputState;
}

/** Unacknowledged inputs are capped (~2 s at 60 Hz) so a lag spike cannot explode re-simulation cost. */
const MAX_PENDING = 120;

/**
 * Client-side prediction with server reconciliation.
 *
 * The client runs the *same* deterministic simulation as the server. Each
 * local tick it applies the local input immediately (no waiting for the
 * network) and remembers it. When an authoritative snapshot arrives it:
 *   1. restores the authoritative state,
 *   2. drops inputs the server has acknowledged,
 *   3. re-applies the remaining (unacknowledged) inputs,
 * so the predicted state is always "authoritative past + my recent inputs".
 * Remote players keep their last known input during prediction.
 */
export class Predictor {
  readonly sim: GameSimulation;
  localId = 0;
  nextSeq = 1;
  lastAck = 0;
  lastSnapshotSeq = 0;
  lastSnapshotTick = -1;
  /** Distance between predicted and authoritative local position for the last acked input. */
  predictionError = 0;
  /** Number of re-simulated ticks during the last reconciliation. */
  lastReplayCount = 0;
  private pending: PendingInput[] = [];
  private predictedAfter = new Map<number, { x: number; y: number }>();

  constructor(sim: GameSimulation) {
    this.sim = sim;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Forget all prediction state (new room, reconnect, config change). */
  reset(): void {
    this.pending.length = 0;
    this.predictedAfter.clear();
    this.nextSeq = 1;
    this.lastAck = 0;
    this.lastSnapshotSeq = 0;
    this.lastSnapshotTick = -1;
  }

  /** Stamps a local input, predicts one tick with it and returns it for sending. */
  advance(input: InputState): PendingInput {
    const entry: PendingInput = { seq: this.nextSeq++, input: { x: input.x, y: input.y, kick: input.kick } };
    this.pending.push(entry);
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    this.simulate(entry);
    return entry;
  }

  private simulate(entry: PendingInput): void {
    const sim = this.sim;
    if (this.localId) sim.setInput(this.localId, entry.input.x, entry.input.y, entry.input.kick);
    sim.step();
    const p = this.localId ? sim.getPlayer(this.localId) : undefined;
    if (p) this.predictedAfter.set(entry.seq, { x: p.body.x, y: p.body.y });
  }

  /**
   * Applies an authoritative snapshot. Returns false when the snapshot is
   * stale (duplicate or out of order) and was ignored.
   */
  reconcile(snap: DecodedSnapshot): boolean {
    if (snap.seq <= this.lastSnapshotSeq) return false;
    this.lastSnapshotSeq = snap.seq;
    this.lastSnapshotTick = snap.state.tick;

    const predicted = this.predictedAfter.get(snap.ackSeq);
    const server = snap.state.players.find((p) => p.id === this.localId);
    this.predictionError = predicted && server ? Math.hypot(predicted.x - server.x, predicted.y - server.y) : 0;

    this.lastAck = snap.ackSeq;
    while (this.pending.length > 0 && this.pending[0]!.seq <= snap.ackSeq) this.pending.shift();
    for (const seq of this.predictedAfter.keys()) if (seq <= snap.ackSeq) this.predictedAfter.delete(seq);

    const sim = this.sim;
    sim.setState(snap.state);
    const emit = sim.emitEvents;
    sim.emitEvents = false;
    for (const entry of this.pending) this.simulate(entry);
    sim.emitEvents = emit;
    this.lastReplayCount = this.pending.length;
    return true;
  }

  /** The most recent inputs for an input packet (redundancy against loss). */
  packetInputs(max = MAX_INPUTS_PER_PACKET): PendingInput[] {
    return this.pending.slice(-max);
  }
}
