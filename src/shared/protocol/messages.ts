/**
 * Binary wire format for high-frequency messages (inputs, snapshots,
 * ping/pong). Low-frequency control messages are JSON (see control.ts).
 *
 * All multi-byte values are little-endian. Positions/velocities are float32;
 * the simulation quantises its state to float32 after every tick, so a
 * snapshot reproduces the authoritative state bit-exactly.
 */
import { AXIS_MAX, INPUT_REDUNDANCY, type MatchPhase, type PlayingTeam } from '../constants/game.ts';
import type { InputState, MatchStateData, PlayerStateData, SimStateData } from '../types/index.ts';
import { ByteReader, ByteWriter, DecodeError } from './binary.ts';

export const MSG_INPUT = 0x01;
export const MSG_PING = 0x02;
export const MSG_SNAPSHOT = 0x81;
export const MSG_PONG = 0x82;
export const MSG_REPLAY = 0x83;

export const MAX_INPUTS_PER_PACKET = 8;
export const MAX_CLIENT_BINARY_BYTES = 64;

// ------------------------------------------------------------------ input

export interface InputPacket {
  /** Sequence number of the last input in `inputs`. */
  newestSeq: number;
  /** Oldest → newest; input i has seq newestSeq − (len − 1 − i). */
  inputs: InputState[];
}

export function encodeInputPacket(newestSeq: number, inputs: readonly InputState[]): Uint8Array {
  const count = Math.min(inputs.length, MAX_INPUTS_PER_PACKET);
  const w = new ByteWriter(8 + count * 3);
  w.u8(MSG_INPUT).u32(newestSeq).u8(count);
  for (let i = inputs.length - count; i < inputs.length; i++) {
    const inp = inputs[i]!;
    w.i8(inp.x).i8(inp.y).u8(inp.kick ? 1 : 0);
  }
  return w.finish();
}

/** Returns null for malformed packets (never throws). */
export function decodeInputPacket(data: Uint8Array): InputPacket | null {
  if (data.byteLength > MAX_CLIENT_BINARY_BYTES) return null;
  try {
    const r = new ByteReader(data);
    if (r.u8() !== MSG_INPUT) return null;
    const newestSeq = r.u32();
    const count = r.u8();
    if (count < 1 || count > MAX_INPUTS_PER_PACKET || newestSeq < count) return null;
    const inputs: InputState[] = [];
    for (let i = 0; i < count; i++) {
      const x = r.i8();
      const y = r.i8();
      const flags = r.u8();
      if (x < -AXIS_MAX || y < -AXIS_MAX || (flags & ~1) !== 0) return null;
      inputs.push({ x, y, kick: (flags & 1) === 1 });
    }
    if (r.remaining !== 0) return null;
    return { newestSeq, inputs };
  } catch (e) {
    if (e instanceof DecodeError) return null;
    throw e;
  }
}

export { INPUT_REDUNDANCY };

// ------------------------------------------------------------------ ping / pong

/** Ping carries the client's clock and its current RTT estimate (shown in the roster). */
export function encodePing(clientTime: number, rttMs: number): Uint8Array {
  return new ByteWriter(11).u8(MSG_PING).f64(clientTime).u16(Math.max(0, Math.min(65535, Math.round(rttMs)))).finish();
}

export function decodePing(data: Uint8Array): { clientTime: number; rtt: number } | null {
  if (data.byteLength !== 11) return null;
  try {
    const r = new ByteReader(data);
    if (r.u8() !== MSG_PING) return null;
    return { clientTime: r.finite64(), rtt: r.u16() };
  } catch {
    return null;
  }
}

export function encodePong(clientTime: number, serverTime: number): Uint8Array {
  return new ByteWriter(17).u8(MSG_PONG).f64(clientTime).f64(serverTime).finish();
}

export function decodePong(data: Uint8Array): { clientTime: number; serverTime: number } | null {
  try {
    const r = new ByteReader(data);
    if (r.u8() !== MSG_PONG) return null;
    return { clientTime: r.finite64(), serverTime: r.finite64() };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ snapshot

export interface SnapshotHeader {
  /** Monotonic per-connection snapshot sequence (loss/duplicate/reorder detection). */
  seq: number;
  /** Last input sequence the server consumed for the recipient (0 = none). */
  ackSeq: number;
  /** Recipient's buffered input count after this tick (time-dilation feedback). */
  queueDepth: number;
  /** Incremented whenever room settings/physics change; stale snapshots are dropped. */
  configVersion: number;
  /** Server clock (ms) of the snapshot tick. */
  serverTime: number;
}

export interface DecodedSnapshot extends SnapshotHeader {
  state: SimStateData;
}

const SNAPSHOT_HEADER_BYTES = 1 + 4 + 4 + 1 + 2 + 8;

/** Encodes the recipient-independent part of a snapshot once per broadcast. */
export function encodeSnapshotBody(s: SimStateData): Uint8Array {
  const w = new ByteWriter(64 + s.players.length * 24);
  w.u32(s.tick).u32(s.rng);
  const m = s.match;
  w.u8(m.phase)
    .u32(m.phaseTicks)
    .u16(m.scoreRed)
    .u16(m.scoreBlue)
    .u32(m.timeTicks)
    .u8(m.kickoffTeam)
    .u8(m.firstKickoffTeam)
    .u8((m.kickoffActive ? 1 : 0) | (m.overtime ? 2 : 0) | (m.matchOver ? 4 : 0))
    .u8(m.half)
    .u8(m.round)
    .u8(m.roundWinsRed)
    .u8(m.roundWinsBlue)
    .u16(m.ballResetTicks)
    .u8(m.lastTouchId)
    .u8(m.prevTouchId);
  const b = s.ball;
  w.f32(b.x).f32(b.y).f32(b.vx).f32(b.vy).f32(b.w);
  w.u8(s.players.length);
  for (const p of s.players) {
    w.u8(p.id).u8(p.team).f32(p.x).f32(p.y).f32(p.vx).f32(p.vy).i8(p.ix).i8(p.iy);
    w.u8((p.kick ? 1 : 0) | (p.kickLatch ? 2 : 0) | (p.touching ? 4 : 0));
    w.u8(Math.min(255, p.cooldown));
  }
  return w.finish();
}

export function encodeSnapshot(h: SnapshotHeader, body: Uint8Array): Uint8Array {
  const w = new ByteWriter(SNAPSHOT_HEADER_BYTES + body.byteLength);
  w.u8(MSG_SNAPSHOT).u32(h.seq).u32(h.ackSeq).u8(Math.min(255, h.queueDepth)).u16(h.configVersion & 0xffff).f64(h.serverTime);
  w.bytesRaw(body);
  return w.finish();
}

function team(v: number): PlayingTeam {
  if (v !== 1 && v !== 2) throw new DecodeError('bad team');
  return v;
}

export function decodeSnapshot(data: Uint8Array): DecodedSnapshot | null {
  try {
    const r = new ByteReader(data);
    if (r.u8() !== MSG_SNAPSHOT) return null;
    const seq = r.u32();
    const ackSeq = r.u32();
    const queueDepth = r.u8();
    const configVersion = r.u16();
    const serverTime = r.finite64();
    const tick = r.u32();
    const rng = r.u32();
    const phase = r.u8();
    if (phase > 6) return null;
    const match: MatchStateData = {
      phase: phase as MatchPhase,
      phaseTicks: r.u32(),
      scoreRed: r.u16(),
      scoreBlue: r.u16(),
      timeTicks: r.u32(),
      kickoffTeam: team(r.u8()),
      firstKickoffTeam: team(r.u8()),
      kickoffActive: false,
      overtime: false,
      matchOver: false,
      half: 1,
      round: 1,
      roundWinsRed: 0,
      roundWinsBlue: 0,
      ballResetTicks: 0,
      lastTouchId: 0,
      prevTouchId: 0,
    };
    const flags = r.u8();
    match.kickoffActive = (flags & 1) !== 0;
    match.overtime = (flags & 2) !== 0;
    match.matchOver = (flags & 4) !== 0;
    match.half = r.u8();
    match.round = r.u8();
    match.roundWinsRed = r.u8();
    match.roundWinsBlue = r.u8();
    match.ballResetTicks = r.u16();
    match.lastTouchId = r.u8();
    match.prevTouchId = r.u8();
    const ball = { x: r.finite32(), y: r.finite32(), vx: r.finite32(), vy: r.finite32(), w: r.finite32() };
    const count = r.u8();
    const players: PlayerStateData[] = [];
    for (let i = 0; i < count; i++) {
      const id = r.u8();
      const t = team(r.u8());
      const x = r.finite32();
      const y = r.finite32();
      const vx = r.finite32();
      const vy = r.finite32();
      const ix = r.i8();
      const iy = r.i8();
      const pf = r.u8();
      const cooldown = r.u8();
      players.push({ id, team: t, x, y, vx, vy, ix, iy, kick: (pf & 1) !== 0, kickLatch: (pf & 2) !== 0, touching: (pf & 4) !== 0, cooldown });
    }
    if (r.remaining !== 0) return null;
    return { seq, ackSeq, queueDepth, configVersion, serverTime, state: { tick, rng, match, ball, players } };
  } catch (e) {
    if (e instanceof DecodeError) return null;
    throw e;
  }
}

/** Reads the message type of a binary frame (0 when empty). */
export function messageType(data: Uint8Array): number {
  return data.byteLength > 0 ? data[0]! : 0;
}
