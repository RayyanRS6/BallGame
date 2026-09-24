/**
 * Headless multiplayer harness: a real RoomManager + ClientSessions connected
 * to headless clients (real Predictor) through simulated network links, all
 * driven by a virtual clock so tests are fast and reproducible.
 */
import { Predictor } from '../src/client/prediction/predictor.ts';
import { defaultConfig, type ServerConfig } from '../src/server/config.ts';
import { ClientSession, type Transport } from '../src/server/network/client-session.ts';
import { silentLogger } from '../src/server/observability/logger.ts';
import { Metrics } from '../src/server/observability/metrics.ts';
import { RoomManager } from '../src/server/rooms/room-manager.ts';
import { GAME_VERSION, PROTOCOL_VERSION } from '../src/shared/constants/game.ts';
import { PERFECT_LINK, LinkSimulator, type LinkConditions } from '../src/shared/net/link-simulator.ts';
import { parseServerControl, type ClientControl, type RoomInfo, type ServerControl } from '../src/shared/protocol/control.ts';
import { decodeSnapshot, encodeInputPacket, MSG_SNAPSHOT, messageType, type DecodedSnapshot } from '../src/shared/protocol/messages.ts';
import { getMap } from '../src/shared/simulation/maps.ts';
import { GameSimulation } from '../src/shared/simulation/simulation.ts';
import type { InputState } from '../src/shared/types/index.ts';
import { lcg } from './helpers.ts';

type Packet = string | Uint8Array;

export class Harness {
  now = 0;
  readonly config: ServerConfig;
  readonly metrics = new Metrics();
  readonly manager: RoomManager;
  readonly clients: TestClient[] = [];

  constructor(config: Partial<ServerConfig> = {}) {
    this.config = defaultConfig(config);
    this.manager = new RoomManager({ config: this.config, logger: silentLogger, metrics: this.metrics, now: () => this.now });
  }

  connect(name: string, conditions: LinkConditions = PERFECT_LINK, seed = 1): TestClient {
    const c = new TestClient(this, name, conditions, seed);
    this.clients.push(c);
    return c;
  }

  /** Advances virtual time in 1 ms steps, ticking server and clients. */
  advance(ms: number, onClientTick?: (c: TestClient) => InputState | null): void {
    for (let i = 0; i < ms; i++) {
      this.now += 1;
      for (const c of this.clients) c.pump(this.now);
      this.manager.advance(this.now);
      for (const c of this.clients) c.maybeTick(this.now, onClientTick);
    }
  }
}

export class TestClient {
  readonly name: string;
  readonly session: ClientSession;
  readonly up: LinkSimulator<Packet>;
  readonly down: LinkSimulator<Packet>;
  readonly transport: Transport & { closed: boolean; ip: string };
  readonly controls: ServerControl[] = [];
  readonly snapshots: DecodedSnapshot[] = [];
  predictor: Predictor | null = null;
  room: RoomInfo | null = null;
  playerId = 0;
  token = '';
  code = '';
  lastSnapshot: DecodedSnapshot | null = null;
  /** Local ticks advance at exactly the room tick rate. */
  private nextTickAt = 0;
  ticking = false;
  private harness: Harness;

  constructor(harness: Harness, name: string, conditions: LinkConditions, seed: number) {
    this.harness = harness;
    this.name = name;
    this.up = new LinkSimulator<Packet>(conditions, lcg(seed));
    this.down = new LinkSimulator<Packet>(conditions, lcg(seed * 7919 + 1));
    const self = this;
    this.transport = {
      ip: `10.0.0.${seed % 250}`,
      bufferedAmount: 0,
      closed: false,
      send(data) {
        self.down.send(data, harness.now, typeof data === 'string');
      },
      close() {
        this.closed = true;
      },
    };
    this.session = new ClientSession(this.transport, {
      manager: harness.manager,
      logger: silentLogger,
      metrics: harness.metrics,
      serverInfo: { name: 'test', region: 'Local', version: GAME_VERSION },
      now: () => harness.now,
    });
    this.send({ t: 'hello', v: PROTOCOL_VERSION, name, avatar: name.slice(0, 2) });
  }

  send(msg: ClientControl | Record<string, unknown>): void {
    this.up.send(JSON.stringify(msg), this.harness.now, true);
  }

  sendRaw(data: Packet, reliable = false): void {
    this.up.send(data, this.harness.now, reliable);
  }

  pump(now: number): void {
    this.up.poll(now, (d) => this.session.handleMessage(d));
    this.down.poll(now, (d) => this.receive(d));
  }

  private receive(d: Packet): void {
    if (typeof d === 'string') {
      const msg = parseServerControl(d);
      if (!msg) throw new Error('bad server message');
      this.controls.push(msg);
      if (msg.t === 'joined') {
        this.playerId = msg.playerId;
        this.token = msg.token;
        this.code = msg.code;
        this.setupRoom(msg.room);
      } else if (msg.t === 'room') {
        this.setupRoom(msg.room);
      }
      return;
    }
    if (messageType(d) === MSG_SNAPSHOT) {
      const snap = decodeSnapshot(d);
      if (!snap) throw new Error('bad snapshot');
      if (!this.room || snap.configVersion !== this.room.configVersion) return;
      this.snapshots.push(snap);
      this.lastSnapshot = snap;
      this.predictor?.reconcile(snap);
    }
  }

  private setupRoom(room: RoomInfo): void {
    this.room = room;
    const sim = new GameSimulation({
      map: getMap(room.settings.match.mapId),
      physics: room.physics,
      settings: room.settings.match,
      tickRate: room.settings.tickRate,
      seed: 0,
    });
    this.predictor = new Predictor(sim);
    this.predictor.localId = this.playerId;
    this.nextTickAt = this.harness.now;
  }

  maybeTick(now: number, onTick?: (c: TestClient) => InputState | null): void {
    if (!this.ticking || !this.predictor || !this.room || !this.lastSnapshot) {
      this.nextTickAt = now;
      return;
    }
    const tickMs = 1000 / this.room.settings.tickRate;
    while (now >= this.nextTickAt) {
      this.nextTickAt += tickMs;
      const input = onTick?.(this) ?? { x: 0, y: 0, kick: false };
      this.predictor.advance(input);
      const inputs = this.predictor.packetInputs(6);
      const newest = inputs[inputs.length - 1]!.seq;
      this.up.send(encodeInputPacket(newest, inputs.map((p) => p.input)), now, false);
    }
  }

  lastControl<T extends ServerControl['t']>(t: T): Extract<ServerControl, { t: T }> | undefined {
    for (let i = this.controls.length - 1; i >= 0; i--) if (this.controls[i]!.t === t) return this.controls[i] as Extract<ServerControl, { t: T }>;
    return undefined;
  }

  disconnect(): void {
    this.ticking = false;
    this.session.onClose();
  }
}
