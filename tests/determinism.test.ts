import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { TEAM_BLUE, TEAM_RED } from '../src/shared/constants/game.ts';
import { BotBrain } from '../src/shared/simulation/ai.ts';
import { decodeReplay, encodeReplay, ReplayPlayer, ReplayRecorder } from '../src/shared/simulation/replay.ts';
import type { GameSimulation } from '../src/shared/simulation/simulation.ts';
import { lcg, makeSim } from './helpers.ts';

function scriptedInputs(sim: GameSimulation, rnd: () => number, t: number) {
  if (t % 5 !== 0) return;
  for (const p of sim.players) sim.setInput(p.id, Math.round((rnd() * 2 - 1) * 127), Math.round((rnd() * 2 - 1) * 127), rnd() < 0.25);
}

function populated(seed = 5, count = 6) {
  const sim = makeSim({ seed, settings: { timeLimit: 120 } });
  for (let i = 1; i <= count; i++) sim.addPlayer(i, i % 2 ? TEAM_RED : TEAM_BLUE);
  sim.startMatch();
  return sim;
}

describe('determinism', () => {
  test('same initial state + same inputs ⇒ identical state every tick', () => {
    const a = populated();
    const b = populated();
    const ra = lcg(42);
    const rb = lcg(42);
    for (let t = 0; t < 6000; t++) {
      scriptedInputs(a, ra, t);
      scriptedInputs(b, rb, t);
      a.step();
      b.step();
      if (t % 100 === 0) assert.equal(a.hash(), b.hash(), `diverged at tick ${t}`);
    }
    assert.equal(a.hash(), b.hash());
  });

  test('restoring a saved state continues identically (prediction/keyframes)', () => {
    const a = populated();
    const rnd = lcg(3);
    for (let t = 0; t < 1500; t++) {
      scriptedInputs(a, rnd, t);
      a.step();
    }
    const saved = a.getState();
    const b = makeSim({ seed: 999, settings: { timeLimit: 120 } });
    b.setState(saved);
    const r1 = lcg(8);
    const r2 = lcg(8);
    for (let t = 0; t < 2000; t++) {
      scriptedInputs(a, r1, t);
      scriptedInputs(b, r2, t);
      a.step();
      b.step();
    }
    assert.equal(a.hash(), b.hash());
  });

  // Both rates integrate with the same 1/120 s substep; only the float32
  // quantisation at tick boundaries differs, so results agree to ~1e-4 u.
  test('physics is equivalent at 30 Hz and 60 Hz tick rates', () => {
    const mk = (tickRate: number) => {
      const sim = makeSim({ tickRate, physics: { kickForce: 0 } });
      sim.addPlayer(1, TEAM_RED);
      sim.addPlayer(2, TEAM_BLUE);
      sim.resetBall(-50, 10, 300, 40);
      return sim;
    };
    const s60 = mk(60);
    const s30 = mk(30);
    const pattern = (sec: number) => (sec < 0.5 ? [127, 0] : sec < 1 ? [0, 127] : [-90, -90]);
    for (let t = 0; t < 120; t++) {
      const [x, y] = pattern(t / 60);
      s60.setInput(1, x!, y!, false);
      s60.setInput(2, -x!, y!, false);
      s60.step();
    }
    for (let t = 0; t < 60; t++) {
      const [x, y] = pattern(t / 30);
      s30.setInput(1, x!, y!, false);
      s30.setInput(2, -x!, y!, false);
      s30.step();
    }
    const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-2, `${a} vs ${b}`);
    for (const id of [1, 2]) {
      close(s60.getPlayer(id)!.body.x, s30.getPlayer(id)!.body.x);
      close(s60.getPlayer(id)!.body.y, s30.getPlayer(id)!.body.y);
    }
    close(s60.ball.x, s30.ball.x);
    close(s60.ball.y, s30.ball.y);
  });

  test('replay reproduces the match bit-exactly, including roster changes', () => {
    const sim = populated(77, 2);
    const bots = sim.players.map((p) => new BotBrain(p.id, 'hard', 1234));
    const rec = new ReplayRecorder(sim, 77, 'test');
    for (const p of sim.players) rec.describePlayer({ id: p.id, name: `P${p.id}`, avatar: '', team: p.team });
    for (let t = 0; t < 7000; t++) {
      if (t === 1000) {
        sim.setPlayerTeam(3, TEAM_RED);
        rec.recordRoster(sim.tick, 3, TEAM_RED);
        bots.push(new BotBrain(3, 'easy', 5));
      }
      if (t === 2500) {
        sim.setPlayerTeam(3, 0);
        rec.recordRoster(sim.tick, 3, 0);
      }
      for (const b of bots) {
        if (!sim.getPlayer(b.id)) continue;
        const inp = b.think(sim);
        sim.setInput(b.id, inp.x, inp.y, inp.kick);
      }
      rec.recordInputs(sim);
      sim.step();
    }
    const data = rec.finish(sim);
    const decoded = decodeReplay(encodeReplay(data));
    const player = new ReplayPlayer(decoded);
    while (player.step());
    assert.equal(player.sim.hash(), data.finalHash);
    assert.deepEqual(player.sim.getStats(), sim.getStats());
    assert.ok(sim.match.scoreRed + sim.match.scoreBlue > 0, 'bots scored at least once');

    // Seeking via keyframes lands on the same state as linear playback.
    player.buildKeyframes();
    player.seek(data.startTick + 5100);
    const viaSeek = player.sim.hash();
    const linear = new ReplayPlayer(decoded);
    while (linear.tick < data.startTick + 5100) linear.step();
    assert.equal(viaSeek, linear.sim.hash());
  });
});
