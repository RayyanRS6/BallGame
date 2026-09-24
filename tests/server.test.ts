import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { InputBuffer } from '../src/server/match/input-buffer.ts';
import { ClientSession } from '../src/server/network/client-session.ts';
import { silentLogger } from '../src/server/observability/logger.ts';
import { PHASE_GOAL_PAUSE, PHASE_LOBBY, PHASE_PLAYING, TEAM_BLUE, TEAM_RED, TEAM_SPECTATOR } from '../src/shared/constants/game.ts';
import { decodeReplay, ReplayPlayer } from '../src/shared/simulation/replay.ts';
import { encodeInputPacket, MSG_REPLAY } from '../src/shared/protocol/messages.ts';
import { Harness, type TestClient } from './net-harness.ts';

function setupMatch(h: Harness, opts: { match?: Record<string, unknown> } = {}) {
  const a = h.connect('Alice', undefined, 1);
  h.advance(5);
  a.send({ t: 'create', room: { name: 'Test', match: { timeLimit: 120, ...opts.match } } });
  h.advance(5);
  assert.ok(a.code, 'room created');
  const b = h.connect('Bob', undefined, 2);
  h.advance(5);
  b.send({ t: 'join', code: a.code });
  h.advance(5);
  a.send({ t: 'team', team: TEAM_RED });
  b.send({ t: 'team', team: TEAM_BLUE });
  h.advance(5);
  a.send({ t: 'start' });
  h.advance(5);
  const room = h.manager.get(a.code)!;
  assert.equal(room.sim.players.length, 2, 'both players on the pitch');
  return { a, b, room };
}

function errors(c: TestClient): string[] {
  return c.controls.filter((m) => m.t === 'error').map((m) => (m as { code: string }).code);
}

describe('rooms', () => {
  test('two players connect to the same room and play', () => {
    const h = new Harness();
    const { a, b, room } = setupMatch(h);
    assert.equal(room.members.size, 2);
    assert.equal(room.sim.players.length, 2);
    assert.notEqual(room.sim.match.phase, PHASE_LOBBY);
    assert.ok(a.lastControl('joined') && b.lastControl('joined'));
    h.advance(4000);
    assert.equal(room.sim.match.phase, PHASE_PLAYING);
    assert.ok(a.snapshots.length > 100 && b.snapshots.length > 100, 'snapshots streamed');
  });

  test('join errors: unknown room, wrong password, full room', () => {
    const h = new Harness();
    const a = h.connect('A', undefined, 1);
    h.advance(5);
    a.send({ t: 'create', room: { name: 'Locked', password: 'secret', maxPlayers: 2 } });
    h.advance(5);
    const b = h.connect('B', undefined, 2);
    h.advance(5);
    b.send({ t: 'join', code: 'ZZZZ' });
    b.send({ t: 'join', code: a.code, password: 'wrong' });
    h.advance(5);
    assert.deepEqual(errors(b), ['room_not_found', 'bad_password']);
    b.send({ t: 'join', code: a.code, password: 'secret' });
    h.advance(5);
    assert.equal(b.code, a.code);
    const c = h.connect('C', undefined, 3);
    h.advance(5);
    c.send({ t: 'join', code: a.code, password: 'secret' });
    h.advance(5);
    assert.deepEqual(errors(c), ['room_full']);
  });

  test('team switching is locked during an active match (host can still move players)', () => {
    const h = new Harness();
    const { a, b, room } = setupMatch(h);
    b.send({ t: 'team', team: TEAM_SPECTATOR });
    h.advance(5);
    assert.deepEqual(errors(b), ['team_locked']);
    assert.equal(room.members.get(b.playerId)!.team, TEAM_BLUE);
    a.send({ t: 'team', team: TEAM_SPECTATOR, playerId: b.playerId });
    h.advance(5);
    assert.equal(room.members.get(b.playerId)!.team, TEAM_SPECTATOR);
  });

  test('only the host can start, stop or change settings', () => {
    const h = new Harness();
    const { b } = setupMatch(h);
    b.send({ t: 'stop' });
    b.send({ t: 'settings', room: { name: 'Hijack' } });
    h.advance(5);
    assert.deepEqual(errors(b), ['not_host', 'not_host']);
  });

  test('host migrates when the host leaves', () => {
    const h = new Harness();
    const { a, b, room } = setupMatch(h);
    a.send({ t: 'leave' });
    h.advance(10);
    assert.equal(room.hostId, b.playerId);
  });

  test('bots can be added by the host and play through inputs only', () => {
    const h = new Harness();
    const a = h.connect('A', undefined, 1);
    h.advance(5);
    a.send({ t: 'create', room: { match: { teamSize: 2 } } });
    h.advance(5);
    a.send({ t: 'team', team: TEAM_RED });
    a.send({ t: 'addBot', team: TEAM_BLUE });
    a.send({ t: 'addBot', team: TEAM_BLUE });
    a.send({ t: 'addBot', team: TEAM_BLUE });
    h.advance(5);
    const room = h.manager.get(a.code)!;
    assert.equal(room.sim.teamCount(TEAM_BLUE), 2, 'team size respected');
    assert.deepEqual(errors(a), ['team_full']);
    a.send({ t: 'start' });
    h.advance(6000);
    const moved = room.sim.players.filter((p) => p.team === TEAM_BLUE).some((p) => Math.hypot(p.body.vx, p.body.vy) > 1 || p.body.x < 400);
    assert.ok(moved, 'bots move');
  });
});

describe('timing', () => {
  test('snapshot timestamps stay aligned with real time after a persistent room idles', () => {
    const h = new Harness();
    const room = h.manager.createRoom({ name: 'Arena' }, { persistent: true, autoStart: true })!;
    h.advance(10_000); // nobody there: the room sleeps
    const c = h.connect('Late', undefined, 5);
    h.advance(5);
    c.send({ t: 'join', code: room.code });
    h.advance(500);
    const snap = c.lastSnapshot!;
    assert.ok(snap, 'snapshots flowing');
    assert.ok(Math.abs(snap.serverTime - h.now) < 40, `serverTime ${snap.serverTime.toFixed(1)} vs now ${h.now}`);
  });
});

describe('reconnection', () => {
  test('a dropped player can reconnect and keeps identity and team', () => {
    const h = new Harness();
    const { b, room } = setupMatch(h);
    const id = b.playerId;
    b.disconnect();
    h.advance(1000);
    const member = room.members.get(id)!;
    assert.equal(member.status, 'reconnecting');
    assert.equal(room.sim.getPlayer(id)?.team, TEAM_BLUE, 'body stays on the pitch');

    const b2 = h.connect('Bob', undefined, 22);
    h.advance(5);
    b2.send({ t: 'rejoin', code: b.code, token: b.token });
    h.advance(5);
    const joined = b2.lastControl('joined')!;
    assert.equal(joined.rejoined, true);
    assert.equal(joined.playerId, id);
    assert.equal(room.members.get(id)!.status, 'connected');
    assert.equal(room.members.get(id)!.team, TEAM_BLUE);
  });

  test('the slot is released after the reconnection window', () => {
    const h = new Harness({ reconnectWindowMs: 2000 });
    const { b, room } = setupMatch(h);
    b.disconnect();
    h.advance(2500);
    assert.equal(room.members.has(b.playerId), false);
    const b2 = h.connect('Bob', undefined, 23);
    h.advance(5);
    b2.send({ t: 'rejoin', code: b.code, token: b.token });
    h.advance(5);
    assert.deepEqual(errors(b2), ['reconnect_failed']);
  });

  test('AI takeover keeps a disconnected player active', () => {
    const h = new Harness({ reconnectWindowMs: 1000 });
    const a = h.connect('A', undefined, 1);
    h.advance(5);
    a.send({ t: 'create', room: { aiTakeover: true } });
    h.advance(5);
    const b = h.connect('B', undefined, 2);
    h.advance(5);
    b.send({ t: 'join', code: a.code });
    h.advance(5);
    a.send({ t: 'team', team: TEAM_RED });
    b.send({ t: 'team', team: TEAM_BLUE });
    h.advance(5);
    a.send({ t: 'start' });
    h.advance(5);
    b.disconnect();
    h.advance(1500);
    const room = h.manager.get(a.code)!;
    assert.equal(room.members.get(b.playerId)?.status, 'ai');
  });
});

describe('authority and anti-cheat', () => {
  test('score and goals are decided by the server', () => {
    const h = new Harness();
    const { a, room } = setupMatch(h);
    h.advance(4000);
    room.sim.resetBall(room.sim.map.halfWidth - 40, 0, 600, 0);
    h.advance(200);
    assert.equal(room.sim.match.phase, PHASE_GOAL_PAUSE);
    assert.equal(room.sim.match.scoreRed, 1);
    h.advance(50);
    assert.ok(a.lastControl('goal'), 'goal broadcast');
    assert.equal(a.lastSnapshot!.state.match.scoreRed, 1, 'score in snapshots');
  });

  test('sending inputs faster than the tick rate gives no speed advantage', () => {
    const buf = new InputBuffer();
    for (let seq = 1; seq <= 100; seq++) buf.push(seq, { x: 127, y: 0, kick: false });
    assert.ok(buf.depth <= buf.maxQueue, 'excess inputs dropped');
    let consumed = 0;
    for (let t = 0; t < 10; t++) if (buf.consume().x === 127) consumed++;
    assert.equal(consumed, 10, 'exactly one input per tick');
    assert.equal(buf.push(5, { x: 0, y: 0, kick: false }), 'stale');
    assert.equal(buf.push(1_000_000, { x: 0, y: 0, kick: false }), 'invalid');
  });

  test('flooding inputs over the network does not move a player faster', () => {
    const run = (flood: boolean) => {
      const h = new Harness();
      const { a, room } = setupMatch(h, { match: { countdownSeconds: 0 } });
      h.advance(400);
      let seq = 1;
      for (let ms = 0; ms < 1000; ms++) {
        if (ms % 17 === 0) {
          const n = flood ? 4 : 1;
          for (let k = 0; k < n; k++) {
            seq++;
            a.sendRaw(encodeInputPacket(seq, [{ x: 127, y: 0, kick: false }]));
          }
        }
        h.advance(1);
      }
      return room.sim.getPlayer(a.playerId)!.body.x;
    };
    const normal = run(false);
    const flooded = run(true);
    assert.ok(flooded <= normal + 1, `normal ${normal}, flooded ${flooded}`);
  });

  test('malformed packets never crash the server and abusive clients are dropped', () => {
    const h = new Harness();
    const { a, room } = setupMatch(h);
    const garbage = [new Uint8Array([0x01, 1, 2]), new Uint8Array([0x77]), new Uint8Array(500), new Uint8Array([0x02])];
    for (let i = 0; i < 40; i++) {
      a.sendRaw(garbage[i % garbage.length]!);
      a.sendRaw('{"t":"team","team":99}', true);
      a.sendRaw('not json', true);
      h.advance(2);
    }
    h.advance(50);
    assert.equal(a.transport.closed, true, 'abusive client disconnected');
    assert.ok(h.metrics.invalidPackets > 0);
    assert.ok(room.members.size >= 1, 'room still alive');
    h.advance(1000);
  });

  test('clients cannot send commands before the handshake', () => {
    const h = new Harness();
    const sent: string[] = [];
    const session = new ClientSession(
      { ip: '1.1.1.1', bufferedAmount: 0, send: (d) => sent.push(String(d)), close() {} },
      { manager: h.manager, logger: silentLogger, metrics: h.metrics, serverInfo: { name: '', region: '', version: '' }, now: () => h.now },
    );
    session.handleMessage(JSON.stringify({ t: 'create', room: {} }));
    assert.equal(h.manager.rooms.size, 0);
    assert.match(sent[0]!, /bad_request/);
  });

  test('the server serves the recorded replay and it reproduces the match', () => {
    const h = new Harness();
    const { a, room } = setupMatch(h, { match: { timeLimit: 60, overtime: false } });
    h.advance(64_000);
    h.advance(6000);
    assert.equal(room.sim.match.phase, PHASE_LOBBY);
    assert.ok(room.lastReplay, 'replay stored');
    a.send({ t: 'getReplay' });
    h.advance(10);
    const data = decodeReplay(room.lastReplay!);
    const player = new ReplayPlayer(data);
    while (player.step());
    assert.equal(player.sim.hash(), data.finalHash);
    void MSG_REPLAY;
  });
});
