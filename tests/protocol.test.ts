import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { TEAM_BLUE, TEAM_RED } from '../src/shared/constants/game.ts';
import { sanitizePhysicsConfig, DEFAULT_PHYSICS } from '../src/shared/constants/physics-config.ts';
import { parseClientControl, sanitizeName } from '../src/shared/protocol/control.ts';
import {
  decodeInputPacket,
  decodeSnapshot,
  encodeInputPacket,
  encodeSnapshot,
  encodeSnapshotBody,
} from '../src/shared/protocol/messages.ts';
import { lcg, makeSim, run } from './helpers.ts';

describe('binary protocol', () => {
  test('snapshots round-trip the simulation state exactly', () => {
    const sim = makeSim();
    sim.addPlayer(1, TEAM_RED);
    sim.addPlayer(2, TEAM_BLUE);
    sim.startMatch();
    sim.setInput(1, 100, -50, true);
    run(sim, 300);
    const state = sim.getState();
    const bytes = encodeSnapshot({ seq: 9, ackSeq: 1234, queueDepth: 3, configVersion: 2, serverTime: 5555.5 }, encodeSnapshotBody(state));
    const snap = decodeSnapshot(bytes)!;
    assert.ok(snap);
    assert.equal(snap.seq, 9);
    assert.equal(snap.ackSeq, 1234);
    assert.equal(snap.queueDepth, 3);
    assert.equal(snap.serverTime, 5555.5);
    assert.deepEqual(snap.state, state);
    assert.ok(bytes.byteLength < 120, `compact: ${bytes.byteLength} bytes for 2 players`);

    // A client restoring the snapshot reproduces the server hash.
    const client = makeSim({ seed: 1 });
    client.setState(snap.state);
    assert.equal(client.hash(), sim.hash());
  });

  test('input packets round-trip and malformed input is rejected', () => {
    const inputs = [
      { x: 127, y: 0, kick: false },
      { x: -127, y: 127, kick: true },
    ];
    const packet = decodeInputPacket(encodeInputPacket(50, inputs))!;
    assert.equal(packet.newestSeq, 50);
    assert.deepEqual(packet.inputs, inputs);

    const bad = encodeInputPacket(50, inputs);
    bad[bad.length - 1] = 0xff; // invalid flag bits
    assert.equal(decodeInputPacket(bad), null);
    assert.equal(decodeInputPacket(new Uint8Array([1, 0, 0])), null);
    assert.equal(decodeInputPacket(new Uint8Array(200)), null);
  });

  test('random garbage never throws from decoders', () => {
    const rnd = lcg(1);
    for (let i = 0; i < 5000; i++) {
      const len = Math.floor(rnd() * 80);
      const data = new Uint8Array(len);
      for (let j = 0; j < len; j++) data[j] = Math.floor(rnd() * 256);
      if (len > 0 && i % 2 === 0) data[0] = i % 4 === 0 ? 0x01 : 0x81;
      decodeInputPacket(data);
      decodeSnapshot(data);
    }
  });
});

describe('control messages', () => {
  test('valid messages parse; invalid ones are rejected', () => {
    assert.deepEqual(parseClientControl('{"t":"join","code":"ab7k","password":"x"}'), { t: 'join', code: 'AB7K', password: 'x' });
    assert.equal(parseClientControl('{"t":"join","code":"ABCDE"}'), null);
    assert.equal(parseClientControl('{"t":"join","code":"AB0K"}'), null, 'ambiguous characters are not in the alphabet');
    assert.equal(parseClientControl('not json'), null);
    assert.equal(parseClientControl('{"t":"team","team":7}'), null);
    assert.equal(parseClientControl('{"t":"nope"}'), null);
    assert.equal(parseClientControl('[1,2,3]'), null);
    assert.equal(parseClientControl('{"t":"rejoin","code":"AB7K","token":"zz"}'), null);
    assert.equal(parseClientControl(`{"t":"chat","text":"${'a'.repeat(9000)}"}`), null, 'oversized');
  });

  test('names are sanitised', () => {
    assert.equal(sanitizeName('  Bob‮\u0000  the   great  '), 'Bob the great');
    assert.equal(sanitizeName('x'.repeat(50)).length, 20);
    assert.equal(sanitizeName(42), 'Player');
  });

  test('physics configs from the network are clamped', () => {
    const cfg = sanitizePhysicsConfig({ ballMass: -5, kickForce: 1e9, playerRadius: 'huge', spinEnabled: 1, evil: 1 });
    assert.equal(cfg.ballMass, 0.05);
    assert.equal(cfg.kickForce, 1000);
    assert.equal(cfg.playerRadius, DEFAULT_PHYSICS.playerRadius);
    assert.equal(cfg.spinEnabled, true);
    assert.equal((cfg as unknown as Record<string, unknown>).evil, undefined);
  });
});
