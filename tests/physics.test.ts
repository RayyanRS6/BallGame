import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { TEAM_BLUE, TEAM_RED } from '../src/shared/constants/game.ts';
import { DEFAULT_PHYSICS } from '../src/shared/constants/physics-config.ts';
import { lcg, makeSim, run, speed } from './helpers.ts';

describe('player movement', () => {
  test('acceleration is gradual, not an instant velocity change', () => {
    const sim = makeSim();
    const p = sim.addPlayer(1, TEAM_RED);
    p.body.x = -300;
    p.body.y = 0;
    sim.setInput(1, 127, 0, false);
    sim.step();
    const v1 = p.body.vx;
    assert.ok(v1 > 0, 'moves in the input direction');
    assert.ok(v1 < DEFAULT_PHYSICS.playerAcceleration / 60 + 1e-6, 'one tick adds at most a·dt');
    run(sim, 30);
    assert.ok(p.body.vx > v1 * 5, 'keeps accelerating while held');
  });

  test('converges to a terminal speed below the safety clamp', () => {
    const sim = makeSim({ mapId: 'stadium' });
    const p = sim.addPlayer(1, TEAM_RED);
    p.body.x = -800;
    p.body.y = 250; // clear of the ball at the centre spot
    sim.setInput(1, 127, 0, false);
    let prev = 0;
    for (let i = 0; i < 300; i++) {
      sim.step();
      assert.ok(p.body.vx >= prev - 1e-9, 'monotonic acceleration');
      prev = p.body.vx;
      if (p.body.x > 700) break;
    }
    const terminal = DEFAULT_PHYSICS.playerAcceleration / DEFAULT_PHYSICS.playerFriction;
    assert.ok(Math.abs(prev - terminal) / terminal < 0.08, `speed ${prev} close to a/k=${terminal}`);
    assert.ok(prev < DEFAULT_PHYSICS.playerMaxSpeed, 'terminal speed does not rely on the clamp');
  });

  test('friction slows the player gradually after release', () => {
    const sim = makeSim();
    const p = sim.addPlayer(1, TEAM_RED);
    p.body.x = -500;
    sim.setInput(1, 127, 0, false);
    run(sim, 60);
    sim.setInput(1, 0, 0, false);
    const start = p.body.vx;
    sim.step();
    assert.ok(p.body.vx < start && p.body.vx > start * 0.9, 'no abrupt stop');
    run(sim, 180);
    assert.ok(p.body.vx < 1, 'eventually stops');
  });

  test('diagonal input is not faster than cardinal input', () => {
    const sim = makeSim();
    const a = sim.addPlayer(1, TEAM_RED);
    const b = sim.addPlayer(2, TEAM_BLUE);
    a.body.x = -300;
    a.body.y = -200;
    b.body.x = 300;
    b.body.y = 0;
    sim.setInput(1, 127, 0, false);
    sim.setInput(2, 127, 127, false);
    run(sim, 40);
    assert.ok(Math.abs(speed(a.body) - speed(b.body)) < 1e-3, `${speed(a.body)} vs ${speed(b.body)}`);
  });
});

describe('collisions', () => {
  test('player-player collision transfers momentum', () => {
    const sim = makeSim({ physics: { playerFriction: 0 } });
    const a = sim.addPlayer(1, TEAM_RED);
    const b = sim.addPlayer(2, TEAM_BLUE);
    sim.ball.x = 0;
    sim.ball.y = 250;
    a.body.x = -200;
    a.body.y = 0;
    a.body.vx = 300;
    b.body.x = -100;
    b.body.y = 0;
    const p0 = a.body.vx + b.body.vx;
    run(sim, 30);
    assert.ok(b.body.vx > 100, 'stationary player receives an impulse');
    assert.ok(a.body.vx < 300, 'moving player loses speed');
    const p1 = a.body.vx + b.body.vx;
    assert.ok(Math.abs(p1 - p0) < 1e-3, 'momentum conserved with equal masses');
    const dist = Math.hypot(a.body.x - b.body.x, a.body.y - b.body.y);
    assert.ok(dist >= a.body.radius + b.body.radius - 1e-6, 'no overlap after contact');
  });

  test('ball bounces off a wall (spec example)', () => {
    const sim = makeSim();
    const W = sim.map.halfWidth;
    sim.resetBall(W - 100, 200, 600, 0);
    run(sim, 30);
    assert.ok(sim.ball.vx < 0, 'velocity reversed');
    assert.ok(sim.ball.x <= W - sim.ball.radius + 1e-6, 'not embedded in the wall');
  });

  test('a moving player hits the ball harder than a stationary one', () => {
    const hit = (playerSpeed: number) => {
      const sim = makeSim({ physics: { spinEnabled: false } });
      const p = sim.addPlayer(1, TEAM_RED);
      p.body.x = -100;
      p.body.y = 0;
      p.body.vx = playerSpeed;
      sim.resetBall(-40, 0, -100, 0);
      run(sim, 20);
      return sim.ball.vx;
    };
    // Ball rolling at −100 u/s into the player.
    const still = hit(0);
    const moving = hit(250);
    assert.ok(Math.abs(still) < 40, `stationary player: small deflection (${still})`);
    assert.ok(moving > 100 && moving - still > 100, `moving player: strong deflection (${moving})`);
  });

  test('a player moving perpendicular deflects the ball sideways', () => {
    const sim = makeSim({ physics: { spinEnabled: false } });
    const p = sim.addPlayer(1, TEAM_RED);
    p.body.x = -20;
    p.body.y = -80;
    p.body.vx = 0;
    p.body.vy = 250;
    sim.resetBall(0, 0, 0, 0);
    run(sim, 20);
    assert.ok(sim.ball.vy > 50, 'pushed along the player motion');
    assert.ok(sim.ball.vx > 0, 'and along the contact normal');
  });

  test('ball never tunnels through walls at maximum speed', () => {
    const sim = makeSim();
    const W = sim.map.halfWidth;
    const H = sim.map.halfHeight;
    const G = sim.map.goalHalfWidth;
    const D = sim.map.goalDepth;
    const rnd = lcg(7);
    for (let trial = 0; trial < 200; trial++) {
      const ang = rnd() * Math.PI * 2;
      const v = DEFAULT_PHYSICS.ballMaxSpeed;
      sim.stopMatch();
      sim.resetBall((rnd() - 0.5) * W, (rnd() - 0.5) * H, Math.cos(ang) * v, Math.sin(ang) * v);
      for (let i = 0; i < 90; i++) {
        sim.step();
        const b = sim.ball;
        const inField = Math.abs(b.x) <= W + 1e-6 && Math.abs(b.y) <= H + 1e-6;
        const inGoal = Math.abs(b.x) <= W + D + 1e-6 && Math.abs(b.y) <= G + 1e-6;
        assert.ok(inField || inGoal, `ball escaped at (${b.x}, ${b.y}) trial ${trial}`);
      }
    }
  });

  test('bounces never add energy', () => {
    const sim = makeSim({ physics: { ballDamping: 0, ballAirResistance: 0, ballRestitution: 1, wallRestitution: 1, spinEnabled: false } });
    sim.resetBall(0, 150, 900, 700);
    let prev = speed(sim.ball);
    for (let i = 0; i < 600; i++) {
      sim.step();
      const s = speed(sim.ball);
      assert.ok(s <= prev + 1e-3, `speed grew ${prev} → ${s}`);
      prev = s;
      if (sim.match.ballResetTicks > 0) break;
    }
  });
});

describe('kick', () => {
  test('kick adds an impulse instead of overwriting velocity', () => {
    const sim = makeSim({ physics: { spinEnabled: false, kickAimInfluence: 0 } });
    const p = sim.addPlayer(1, TEAM_RED);
    p.body.x = -100;
    p.body.y = 0;
    sim.resetBall(-100 + p.body.radius + sim.ball.radius + 2, 0, 0, 120);
    sim.setInput(1, 0, 0, true);
    sim.step();
    const expected = DEFAULT_PHYSICS.kickForce / DEFAULT_PHYSICS.ballMass;
    assert.ok(Math.abs(sim.ball.vx - expected) < expected * 0.05, `vx ${sim.ball.vx} ≈ ${expected}`);
    assert.ok(sim.ball.vy > 100, 'existing momentum preserved');
  });

  test('out of range: no kick', () => {
    const sim = makeSim();
    const p = sim.addPlayer(1, TEAM_RED);
    p.body.x = -200;
    sim.resetBall(0, 0);
    sim.setInput(1, 0, 0, true);
    sim.step();
    assert.equal(speed(sim.ball), 0);
  });

  test('holding kick kicks once; releasing re-arms after cooldown', () => {
    const sim = makeSim({ physics: { spinEnabled: false } });
    const p = sim.addPlayer(1, TEAM_RED);
    let kicks = 0;
    const place = () => {
      p.body.x = -100;
      p.body.y = 0;
      p.body.vx = p.body.vy = 0;
      sim.resetBall(-100 + p.body.radius + sim.ball.radius + 1, 0);
    };
    place();
    for (let i = 0; i < 20; i++) {
      sim.setInput(1, 0, 0, true);
      sim.step();
      kicks += sim.events.filter((e) => e.type === 'kick').length;
      place();
    }
    assert.equal(kicks, 1, 'held button kicks exactly once');
    sim.setInput(1, 0, 0, false);
    run(sim, 10);
    place();
    sim.setInput(1, 0, 0, true);
    sim.step();
    assert.equal(sim.events.filter((e) => e.type === 'kick').length, 1, 're-armed after release');
  });

  test('movement input bends the kick and off-centre kicks create spin', () => {
    const sim = makeSim();
    const p = sim.addPlayer(1, TEAM_RED);
    p.body.x = -100;
    p.body.y = 0;
    sim.resetBall(-100 + p.body.radius + sim.ball.radius + 1, 0);
    sim.setInput(1, 0, 127, true);
    sim.step();
    assert.ok(sim.ball.vy > 0, 'bent towards the input');
    assert.ok(Math.abs(sim.ball.w) > 1, 'spin generated');
    // Spin curves the ball back against the bend (Magnus).
    const vy0 = sim.ball.vy / sim.ball.vx;
    sim.setInput(1, 0, 0, false);
    run(sim, 40);
    assert.ok(sim.ball.vy / sim.ball.vx < vy0, 'trajectory curves');
  });
});

describe('stability', () => {
  test('random play for 20k ticks keeps every body finite and inside the arena', () => {
    const sim = makeSim({ settings: { timeLimit: 0 } });
    for (let i = 1; i <= 8; i++) sim.addPlayer(i, i % 2 ? TEAM_RED : TEAM_BLUE);
    sim.startMatch();
    const rnd = lcg(99);
    for (let t = 0; t < 20000; t++) {
      if (t % 7 === 0) {
        for (let i = 1; i <= 8; i++) sim.setInput(i, Math.round((rnd() * 2 - 1) * 127), Math.round((rnd() * 2 - 1) * 127), rnd() < 0.3);
      }
      sim.step();
      for (const b of sim.world.bodies) {
        assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.vx) && Number.isFinite(b.vy));
        assert.ok(Math.abs(b.x) <= sim.arena.outerX && Math.abs(b.y) <= sim.arena.outerY, `body ${b.id} out of arena`);
        assert.ok(speed(b) <= b.maxSpeed + 1e-3);
      }
      assert.ok(!sim.events.some((e) => e.type === 'fault'), 'no sanity faults');
    }
  });

  test('players cannot overlap significantly under crowding', () => {
    const sim = makeSim();
    for (let i = 1; i <= 6; i++) sim.addPlayer(i, i % 2 ? TEAM_RED : TEAM_BLUE);
    sim.stopMatch();
    for (let i = 1; i <= 6; i++) {
      const p = sim.getPlayer(i)!;
      p.body.x = -400 + i * 5;
      p.body.y = 0;
    }
    for (let t = 0; t < 120; t++) {
      for (let i = 1; i <= 6; i++) sim.setInput(i, -127, 0, false);
      sim.step();
    }
    const ps = sim.players;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i]!.body;
        const b = ps[j]!.body;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        assert.ok(d > (a.radius + b.radius) * 0.9, `players ${a.id}/${b.id} overlap: ${d}`);
      }
    }
  });
});
