import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  PHASE_COUNTDOWN,
  PHASE_GOAL_PAUSE,
  PHASE_HALFTIME,
  PHASE_LOBBY,
  PHASE_MATCH_END,
  PHASE_PLAYING,
  PHASE_RESETTING,
  TEAM_BLUE,
  TEAM_RED,
} from '../src/shared/constants/game.ts';
import type { GameSimulation } from '../src/shared/simulation/simulation.ts';
import { makeSim, run } from './helpers.ts';

function runUntil(sim: GameSimulation, pred: () => boolean, max = 20000): number {
  for (let i = 0; i < max; i++) {
    if (pred()) return i;
    sim.step();
  }
  throw new Error('condition not reached');
}

function startedSim(settings: Parameters<typeof makeSim>[0] = {}) {
  const sim = makeSim(settings);
  sim.addPlayer(1, TEAM_RED);
  sim.addPlayer(2, TEAM_BLUE);
  sim.startMatch();
  runUntil(sim, () => sim.match.phase === PHASE_PLAYING);
  return sim;
}

/** Rolls the ball into the right goal (red scores). */
function shootRight(sim: GameSimulation) {
  sim.resetBall(sim.map.halfWidth - 60, 0, 500, 0);
}

describe('match state machine', () => {
  test('start → resetting → countdown (3,2,1,GO) → playing', () => {
    const sim = makeSim();
    sim.addPlayer(1, TEAM_RED);
    sim.addPlayer(2, TEAM_BLUE);
    sim.startMatch();
    assert.equal(sim.match.phase, PHASE_RESETTING);
    const counts: number[] = [];
    runUntil(sim, () => {
      for (const e of sim.events) if (e.type === 'countdown') counts.push(e.value);
      return sim.match.phase === PHASE_PLAYING;
    });
    assert.deepEqual(counts, [3, 2, 1, 0]);
  });

  test('players are frozen during the countdown', () => {
    const sim = makeSim();
    const p = sim.addPlayer(1, TEAM_RED);
    sim.addPlayer(2, TEAM_BLUE);
    sim.startMatch();
    runUntil(sim, () => sim.match.phase === PHASE_COUNTDOWN);
    const x = p.body.x;
    sim.setInput(1, 127, 0, false);
    run(sim, 30);
    assert.equal(p.body.x, x);
  });

  test('goal is detected once, score increments and the conceding team kicks off', () => {
    const sim = startedSim();
    shootRight(sim);
    let goals = 0;
    for (let i = 0; i < 60; i++) {
      sim.step();
      goals += sim.events.filter((e) => e.type === 'goal').length;
    }
    assert.equal(goals, 1);
    assert.equal(sim.match.scoreRed, 1);
    assert.equal(sim.match.scoreBlue, 0);
    assert.equal(sim.match.phase, PHASE_GOAL_PAUSE);
    assert.equal(sim.match.kickoffTeam, TEAM_BLUE);
  });

  test('ball must fully cross the goal line', () => {
    const sim = startedSim({ physics: { ballDamping: 0, ballAirResistance: 0 } });
    const W = sim.map.halfWidth;
    sim.resetBall(W, 0, 0, 0); // centre on the line
    run(sim, 5);
    assert.equal(sim.match.scoreRed, 0);
    sim.resetBall(W + sim.ball.radius + 1, 0, 0, 0);
    sim.step();
    assert.equal(sim.match.scoreRed, 1);
  });

  test('a ball hitting the post does not count', () => {
    const sim = startedSim();
    const W = sim.map.halfWidth;
    sim.resetBall(W - 80, sim.map.goalHalfWidth, 600, 0);
    run(sim, 40);
    assert.equal(sim.match.scoreRed, 0);
    assert.ok(sim.ball.vx < 0, 'bounced off the post');
  });

  test('after the goal pause: reset positions, countdown, play', () => {
    const sim = startedSim();
    const p1 = sim.getPlayer(1)!;
    p1.body.x = 300;
    shootRight(sim);
    runUntil(sim, () => sim.match.phase === PHASE_RESETTING);
    assert.equal(sim.ball.x, 0);
    assert.equal(sim.ball.y, 0);
    assert.ok(p1.body.x < 0, 'red player back in own half');
    assert.equal(p1.body.vx, 0);
    runUntil(sim, () => sim.match.phase === PHASE_PLAYING);
    assert.equal(sim.match.kickoffActive, true);
  });

  test('kickoff barrier keeps the defending team out of the centre circle', () => {
    const sim = startedSim();
    // Red kicks off? Force blue as defending by making red kick off.
    sim.match.kickoffTeam = TEAM_RED;
    sim.match.kickoffActive = true;
    sim.setState(sim.getState());
    const blue = sim.getPlayer(2)!;
    blue.body.x = 200;
    blue.body.y = 0;
    for (let i = 0; i < 120; i++) {
      sim.setInput(2, -127, 0, false);
      sim.step();
    }
    const d = Math.hypot(blue.body.x, blue.body.y);
    assert.ok(d >= sim.map.centerRadius + blue.body.radius - 2, `blue stayed outside (d=${d})`);
    assert.ok(blue.body.x > 0, 'blue stayed in own half');
  });

  test('kickoff barrier is released once the ball is touched', () => {
    const sim = startedSim();
    sim.match.kickoffTeam = TEAM_RED;
    sim.match.kickoffActive = true;
    sim.setState(sim.getState());
    const red = sim.getPlayer(1)!;
    red.body.x = -60;
    red.body.y = 0;
    for (let i = 0; i < 60 && sim.match.kickoffActive; i++) {
      sim.setInput(1, 127, 0, false);
      sim.step();
    }
    assert.equal(sim.match.kickoffActive, false);
  });

  test('timer ends the match at the time limit', () => {
    const sim = startedSim({ settings: { timeLimit: 60, overtime: false } });
    runUntil(sim, () => sim.match.phase === PHASE_MATCH_END);
    assert.equal(sim.match.timeTicks, 60 * 60);
  });

  test('timer only runs while playing', () => {
    const sim = startedSim({ settings: { timeLimit: 60 } });
    const t0 = sim.match.timeTicks;
    shootRight(sim);
    runUntil(sim, () => sim.match.phase === PHASE_GOAL_PAUSE);
    const t1 = sim.match.timeTicks;
    runUntil(sim, () => sim.match.phase === PHASE_PLAYING);
    assert.ok(sim.match.timeTicks - t1 <= 1, 'paused during goal pause and countdown');
    assert.ok(t1 > t0);
  });

  test('golden goal overtime when tied', () => {
    const sim = startedSim({ settings: { timeLimit: 60, overtime: true } });
    runUntil(sim, () => sim.match.overtime);
    assert.equal(sim.match.phase, PHASE_PLAYING);
    shootRight(sim);
    runUntil(sim, () => sim.match.phase === PHASE_MATCH_END);
    assert.equal(sim.match.scoreRed, 1);
  });

  test('score limit ends the match', () => {
    const sim = startedSim({ settings: { scoreLimit: 2, timeLimit: 0 } });
    for (let g = 0; g < 2; g++) {
      runUntil(sim, () => sim.match.phase === PHASE_PLAYING);
      shootRight(sim);
      runUntil(sim, () => sim.match.phase === PHASE_GOAL_PAUSE);
    }
    runUntil(sim, () => sim.match.phase === PHASE_MATCH_END);
    assert.equal(sim.match.scoreRed, 2);
  });

  test('halftime alternates the kickoff', () => {
    const sim = startedSim({ settings: { timeLimit: 60, halftime: true } });
    const first = sim.match.firstKickoffTeam;
    runUntil(sim, () => sim.match.phase === PHASE_HALFTIME);
    assert.equal(sim.match.half, 2);
    runUntil(sim, () => sim.match.phase === PHASE_PLAYING);
    assert.notEqual(sim.match.kickoffTeam, first);
  });

  test('match end returns to the lobby', () => {
    const sim = startedSim({ settings: { timeLimit: 60, overtime: false, returnToLobby: true } });
    runUntil(sim, () => sim.match.phase === PHASE_MATCH_END);
    runUntil(sim, () => sim.match.phase === PHASE_LOBBY);
  });

  test('tournament: best of 3 plays further rounds until decided', () => {
    const sim = startedSim({ settings: { timeLimit: 60, rounds: 3, mode: 'tournament', returnToLobby: true } });
    for (let round = 1; round <= 2; round++) {
      runUntil(sim, () => sim.match.phase === PHASE_PLAYING && sim.match.round === round);
      shootRight(sim);
      runUntil(sim, () => sim.match.phase === PHASE_GOAL_PAUSE);
      runUntil(sim, () => sim.match.phase === PHASE_MATCH_END);
    }
    assert.equal(sim.match.roundWinsRed, 2);
    assert.ok(sim.isSeriesOver());
    runUntil(sim, () => sim.match.phase === PHASE_LOBBY);
  });

  test('stats: scorer, assist and own goal attribution', () => {
    const sim = makeSim();
    sim.addPlayer(1, TEAM_RED);
    sim.addPlayer(3, TEAM_RED);
    sim.addPlayer(2, TEAM_BLUE);
    sim.startMatch();
    runUntil(sim, () => sim.match.phase === PHASE_PLAYING);
    sim.match.prevTouchId = 3;
    sim.match.lastTouchId = 1;
    shootRight(sim);
    runUntil(sim, () => sim.match.phase === PHASE_GOAL_PAUSE);
    const stats = sim.getStats();
    assert.equal(stats.players.find((p) => p.id === 1)?.goals, 1);
    assert.equal(stats.players.find((p) => p.id === 3)?.assists, 1);

    runUntil(sim, () => sim.match.phase === PHASE_PLAYING);
    sim.match.lastTouchId = 2; // blue touched last, ball into blue's own goal
    shootRight(sim);
    runUntil(sim, () => sim.match.phase === PHASE_GOAL_PAUSE);
    assert.equal(sim.getStats().players.find((p) => p.id === 2)?.ownGoals, 1);
    assert.equal(sim.match.scoreRed, 2);
  });

  test('training mode: goals re-spawn the ball without stopping play', () => {
    const sim = makeSim({ settings: { mode: 'training', timeLimit: 0, kickoffBarrier: false, countdownSeconds: 0 } });
    sim.addPlayer(1, TEAM_RED);
    sim.startFreePlay();
    shootRight(sim);
    runUntil(sim, () => sim.events.some((e) => e.type === 'goal'));
    assert.equal(sim.match.phase, PHASE_PLAYING);
    runUntil(sim, () => sim.ball.x === 0 && sim.ball.y === 0);
  });
});
