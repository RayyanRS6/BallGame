import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ClockSync } from '../src/client/network/clock-sync.ts';
import { InterpolationBuffer } from '../src/client/prediction/interpolation.ts';
import { PHASE_PLAYING, TEAM_BLUE, TEAM_RED } from '../src/shared/constants/game.ts';
import { LinkSimulator, type LinkConditions } from '../src/shared/net/link-simulator.ts';
import type { InputState, SimStateData } from '../src/shared/types/index.ts';
import { lcg } from './helpers.ts';
import { Harness, type TestClient } from './net-harness.ts';

const LATENCIES = [0, 20, 50, 100, 150, 200];

function conditions(latencyMs: number, extra: Partial<LinkConditions> = {}): LinkConditions {
  return { latencyMs: latencyMs / 2, jitterMs: 0, lossRate: 0, duplicateRate: 0, reorder: false, ...extra };
}

/** Scripted input: weave around for a while, then stand still. */
function script(activeUntilTick: number) {
  const counters = new Map<TestClient, number>();
  return (c: TestClient): InputState => {
    const t = (counters.get(c) ?? 0) + 1;
    counters.set(c, t);
    if (t > activeUntilTick) return { x: 0, y: 0, kick: false };
    const phase = Math.floor(t / 40) % 4;
    const dirs = [[127, 0], [0, 127], [-127, 0], [0, -127]] as const;
    const [x, y] = dirs[(phase + (c.name === 'Bob' ? 2 : 0)) % 4]!;
    return { x, y, kick: t % 90 < 5 };
  };
}

function playMatch(cond: LinkConditions, seed = 1) {
  const h = new Harness();
  const a = h.connect('Alice', cond, seed);
  h.advance(400);
  a.send({ t: 'create', room: { match: { timeLimit: 0, countdownSeconds: 0, kickoffBarrier: false } } });
  h.advance(400);
  const b = h.connect('Bob', cond, seed + 100);
  h.advance(400);
  b.send({ t: 'join', code: a.code });
  h.advance(400);
  a.send({ t: 'team', team: TEAM_RED });
  b.send({ t: 'team', team: TEAM_BLUE });
  h.advance(400);
  a.send({ t: 'start' });
  h.advance(600);
  const room = h.manager.get(a.code)!;
  assert.equal(room.sim.match.phase, PHASE_PLAYING);
  a.ticking = true;
  b.ticking = true;
  const errorsA: number[] = [];
  const input = script(360);
  for (let i = 0; i < 90; i++) {
    h.advance(100, input);
    errorsA.push(a.predictor!.predictionError);
  }
  return { h, a, b, room, errorsA };
}

describe('prediction and reconciliation', () => {
  for (const latency of LATENCIES) {
    test(`client prediction converges to the server state (RTT ${latency} ms)`, () => {
      const { a, b, room, errorsA } = playMatch(conditions(latency));
      const serverA = room.sim.getPlayer(a.playerId)!.body;
      const predA = a.predictor!.sim.getPlayer(a.playerId)!.body;
      assert.ok(Math.hypot(serverA.x - predA.x, serverA.y - predA.y) < 0.5, `A converged (${serverA.x},${serverA.y}) vs (${predA.x},${predA.y})`);
      const serverB = room.sim.getPlayer(b.playerId)!.body;
      const predB = b.predictor!.sim.getPlayer(b.playerId)!.body;
      assert.ok(Math.hypot(serverB.x - predB.x, serverB.y - predB.y) < 0.5, 'B converged');
      assert.ok(Math.abs(serverA.x) > 1 || Math.abs(serverA.y) > 1, 'player actually moved');
      assert.equal(errorsA[errorsA.length - 1], 0, 'no prediction error at rest');
      assert.ok(a.predictor!.pendingCount <= Math.ceil(latency / 16.7) + 4, 'unacked inputs bounded by RTT');
    });
  }

  for (const loss of [0.01, 0.05, 0.1]) {
    test(`playable with ${loss * 100}% packet loss, jitter, duplication and reordering`, () => {
      const cond = conditions(100, { jitterMs: 15, lossRate: loss, duplicateRate: 0.02, reorder: true });
      const { a, room, errorsA } = playMatch(cond, 7);
      const serverA = room.sim.getPlayer(a.playerId)!.body;
      const predA = a.predictor!.sim.getPlayer(a.playerId)!.body;
      assert.ok(Math.hypot(serverA.x - predA.x, serverA.y - predA.y) < 1, 'converged after inputs stop');
      const avg = errorsA.reduce((s, e) => s + e, 0) / errorsA.length;
      assert.ok(avg < 25, `average prediction error ${avg.toFixed(2)} u`);
      assert.ok(Math.abs(serverA.x) > 1, 'inputs reached the server');
    });
  }
});

describe('network primitives', () => {
  test('link simulator: latency, loss, duplication and reordering', () => {
    const link = new LinkSimulator<number>({ latencyMs: 50, jitterMs: 20, lossRate: 0.1, duplicateRate: 0.05, reorder: true }, lcg(3));
    for (let i = 0; i < 1000; i++) link.send(i, i, false);
    const got: number[] = [];
    link.poll(1e9, (m) => got.push(m));
    assert.ok(link.dropped > 50 && link.dropped < 150, `dropped ${link.dropped}`);
    assert.ok(link.duplicated > 10, 'duplicates generated');
    let inversions = 0;
    for (let i = 1; i < got.length; i++) if (got[i]! < got[i - 1]!) inversions++;
    assert.ok(inversions > 0, 'reordering happened');

    const reliable = new LinkSimulator<number>({ latencyMs: 50, jitterMs: 20, lossRate: 0.5, duplicateRate: 0.5, reorder: true }, lcg(4));
    for (let i = 0; i < 100; i++) reliable.send(i, i, true);
    const r: number[] = [];
    reliable.poll(1e9, (m) => r.push(m));
    assert.deepEqual(r, [...Array(100).keys()], 'reliable messages are ordered and never lost');
  });

  test('clock sync estimates the server offset within a few ms', () => {
    const clock = new ClockSync();
    const trueOffset = 12345.6;
    const rnd = lcg(11);
    let t = 1000;
    for (let i = 0; i < 20; i++) {
      const up = 40 + rnd() * 20;
      const down = 40 + rnd() * 20;
      const server = t + up + trueOffset;
      clock.addSample(t, server, t + up + down);
      t += 500;
      clock.update(500);
    }
    assert.ok(Math.abs(clock.serverNow(t) - (t + trueOffset)) < 12, 'offset estimate');
    assert.ok(clock.srtt > 80 && clock.srtt < 120, `rtt ${clock.srtt}`);
  });

  test('interpolation buffer blends between snapshots and bounds extrapolation', () => {
    const buf = new InterpolationBuffer();
    const state = (tick: number, x: number): SimStateData => ({
      tick,
      rng: 0,
      ball: { x, y: 0, vx: 600, vy: 0, w: 0 },
      match: {} as SimStateData['match'],
      players: [{ id: 1, team: 1, x, y: 0, vx: 600, vy: 0, ix: 0, iy: 0, kick: false, kickLatch: false, cooldown: 0, touching: false }],
    });
    buf.push(0, state(0, 0));
    buf.push(100, state(6, 60));
    buf.push(100, state(6, 60)); // duplicate ignored
    buf.push(50, state(3, 30)); // out of order inserted
    assert.equal(buf.size, 3);
    const mid = buf.sample(75)!;
    assert.ok(Math.abs(mid.players.get(1)!.x - 45) < 1e-9);
    const ahead = buf.sample(1000)!;
    assert.ok(ahead.extrapolated);
    assert.ok(ahead.ball.x <= 60 + 600 * 0.1 + 1e-9, 'extrapolation capped at 100 ms');
  });
});
