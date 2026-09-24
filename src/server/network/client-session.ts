import { PROTOCOL_VERSION } from '../../shared/constants/game.ts';
import { MAX_CONTROL_BYTES, parseClientControl, type ClientControl, type ErrorCode, type ServerControl, type ServerInfo } from '../../shared/protocol/control.ts';
import { decodeInputPacket, decodePing, encodePong, MAX_CLIENT_BINARY_BYTES, MSG_INPUT, MSG_PING, messageType } from '../../shared/protocol/messages.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import type { Member, Room, RoomClient } from '../rooms/room.ts';
import type { RoomManager } from '../rooms/room-manager.ts';
import { AbuseTracker, type ViolationKind } from '../security/abuse.ts';
import { TokenBucket } from '../security/rate-limit.ts';

/** Minimal transport abstraction (a WebSocket in production, a fake in tests). */
export interface Transport {
  readonly ip: string;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
}

export interface SessionDeps {
  manager: RoomManager;
  logger: Logger;
  metrics: Metrics;
  serverInfo: ServerInfo;
  now: () => number;
}

const ERROR_MESSAGES: Record<ErrorCode, string> = {
  room_not_found: 'Room not found. Check the code and the selected server.',
  room_full: 'This room is full.',
  bad_password: 'Wrong room password.',
  bad_request: 'Invalid request.',
  rate_limited: 'Slow down — too many requests.',
  not_host: 'Only the room host can do that.',
  team_locked: 'Teams are locked while a match is in progress.',
  team_full: 'That team is full.',
  server_full: 'The server is full. Try another region.',
  version_mismatch: 'Your game version does not match the server. Reload the page.',
  reconnect_failed: 'Could not restore your session — the reconnection window has expired.',
  banned: 'You are banned from this room.',
  not_in_room: 'You are not in a room.',
  no_replay: 'No replay available yet.',
};

let nextSessionId = 1;

/** One connected client: protocol parsing, validation, rate limiting, routing. */
export class ClientSession implements RoomClient {
  readonly id = nextSessionId++;
  private transport: Transport;
  private deps: SessionDeps;
  name = 'Player';
  avatar = '';
  greeted = false;
  room: Room | null = null;
  member: Member | null = null;
  lastActivity: number;
  closed = false;
  private binaryBucket: TokenBucket;
  private controlBucket: TokenBucket;
  private chatBucket: TokenBucket;
  private abuse: AbuseTracker;

  constructor(transport: Transport, deps: SessionDeps) {
    this.transport = transport;
    this.deps = deps;
    const now = deps.now();
    this.lastActivity = now;
    // 120 Hz inputs + pings with generous burst for network hiccups.
    this.binaryBucket = new TokenBucket(400, 200, now);
    this.controlBucket = new TokenBucket(30, 5, now);
    this.chatBucket = new TokenBucket(5, 1, now);
    this.abuse = new AbuseTracker(now);
  }

  get ip(): string {
    return this.transport.ip;
  }

  get bufferedAmount(): number {
    return this.transport.bufferedAmount;
  }

  handleMessage(data: string | Uint8Array): void {
    if (this.closed) return;
    const t0 = performance.now();
    const now = this.deps.now();
    this.lastActivity = now;
    this.deps.metrics.messagesIn++;
    this.deps.metrics.bytesIn += typeof data === 'string' ? data.length : data.byteLength;
    try {
      if (typeof data === 'string') this.handleControl(data, now);
      else this.handleBinary(data, now);
    } catch (err) {
      this.deps.logger.error('message_handler_error', { session: this.id, error: String((err as Error)?.stack ?? err) });
      this.violation('malformed_packet', now);
    } finally {
      this.deps.metrics.recordNetwork(performance.now() - t0);
    }
  }

  private handleBinary(data: Uint8Array, now: number): void {
    if (data.byteLength > MAX_CLIENT_BINARY_BYTES) return this.violation('oversized_packet', now);
    if (!this.binaryBucket.take(now)) {
      this.deps.metrics.rateLimited++;
      return this.violation('rate_limited', now);
    }
    switch (messageType(data)) {
      case MSG_INPUT: {
        const packet = decodeInputPacket(data);
        if (!packet) return this.violation('malformed_packet', now);
        if (this.room && this.member) this.room.onInput(this.member, packet);
        return;
      }
      case MSG_PING: {
        const ping = decodePing(data);
        if (!ping) return this.violation('malformed_packet', now);
        if (this.member) this.member.ping = ping.rtt;
        this.sendBinary(encodePong(ping.clientTime, now));
        return;
      }
      default:
        return this.violation('unknown_message', now);
    }
  }

  private handleControl(text: string, now: number): void {
    if (text.length > MAX_CONTROL_BYTES) return this.violation('oversized_packet', now);
    if (!this.controlBucket.take(now)) {
      this.deps.metrics.rateLimited++;
      this.error('rate_limited');
      return this.violation('rate_limited', now);
    }
    const msg = parseClientControl(text);
    if (!msg) {
      this.deps.metrics.invalidPackets++;
      this.deps.logger.warn('invalid_packet', { session: this.id, ip: this.ip });
      return this.violation('malformed_packet', now);
    }
    if (!this.greeted && msg.t !== 'hello') {
      this.error('bad_request');
      return this.violation('invalid_state_transition', now);
    }
    this.dispatch(msg, now);
  }

  private dispatch(msg: ClientControl, now: number): void {
    const manager = this.deps.manager;
    switch (msg.t) {
      case 'hello':
        if (msg.v !== PROTOCOL_VERSION) {
          this.error('version_mismatch');
          this.transport.close(4000, 'version mismatch');
          return;
        }
        this.greeted = true;
        this.name = msg.name;
        this.avatar = msg.avatar;
        this.sendControl({ t: 'welcome', server: this.deps.serverInfo, protocol: PROTOCOL_VERSION });
        return;
      case 'create': {
        this.leaveRoom('switched room');
        const room = manager.createRoom({ name: `${this.name}'s room`, ...msg.room });
        if (!room) return this.error('server_full');
        this.enter(room);
        return;
      }
      case 'join': {
        const room = manager.get(msg.code);
        if (!room) return this.error('room_not_found');
        if (room === this.room) return;
        const err = room.canJoin(msg.password, this.ip);
        if (err) return this.error(err);
        this.leaveRoom('switched room');
        this.enter(room);
        return;
      }
      case 'rejoin': {
        const room = manager.get(msg.code);
        const member = room?.rejoin(msg.token, this) ?? null;
        if (!room || !member) return this.error('reconnect_failed');
        if (this.room && this.room !== room) this.leaveRoom('switched room');
        this.room = room;
        this.member = member;
        return;
      }
      case 'profile':
        this.name = msg.name;
        this.avatar = msg.avatar;
        if (this.room && this.member) this.room.updateProfile(this.member, msg.name, msg.avatar);
        return;
      default:
        break;
    }

    const room = this.room;
    const member = this.member;
    if (!room || !member) return this.error('not_in_room');
    let err: ErrorCode | null = null;
    switch (msg.t) {
      case 'leave':
        this.leaveRoom('left');
        return;
      case 'team':
        err = room.requestTeam(member, msg.team, msg.playerId);
        break;
      case 'settings':
        err = room.updateSettings(member, msg.room);
        break;
      case 'start':
        err = room.requestStart(member);
        break;
      case 'stop':
        err = room.requestStop(member);
        break;
      case 'addBot':
        err = room.requestAddBot(member, msg.team);
        break;
      case 'removeBot':
        err = room.requestRemoveBot(member, msg.playerId);
        break;
      case 'kick':
        err = room.requestKick(member, msg.playerId, msg.ban);
        break;
      case 'chat':
        if (!this.chatBucket.take(now)) {
          err = 'rate_limited';
          this.violation('rate_limited', now);
        } else room.chat(member, msg.text);
        break;
      case 'getReplay':
        err = room.sendReplay(member);
        break;
    }
    if (err) this.error(err);
  }

  private enter(room: Room): void {
    this.room = room;
    this.member = room.addHuman(this, this.name, this.avatar);
  }

  private leaveRoom(reason: string): void {
    if (this.room && this.member) this.room.removeMember(this.member.id, reason);
    this.room = null;
    this.member = null;
  }

  error(code: ErrorCode): void {
    this.sendControl({ t: 'error', code, message: ERROR_MESSAGES[code] });
  }

  sendControl(msg: ServerControl): void {
    if (this.closed) return;
    const text = JSON.stringify(msg);
    this.deps.metrics.messagesOut++;
    this.deps.metrics.bytesOut += text.length;
    this.transport.send(text);
  }

  sendBinary(data: Uint8Array): void {
    if (this.closed) return;
    this.deps.metrics.messagesOut++;
    this.deps.metrics.bytesOut += data.byteLength;
    this.transport.send(data);
  }

  flag(kind: 'input_flood' | 'input_sequence' | 'invalid_state_transition'): void {
    this.violation(kind, this.deps.now());
  }

  detachFromRoom(reason: string): void {
    this.room = null;
    this.member = null;
    this.sendControl({ t: 'left', reason });
  }

  private violation(kind: ViolationKind, now: number): void {
    if (kind === 'malformed_packet' || kind === 'oversized_packet' || kind === 'unknown_message') this.deps.metrics.invalidPackets++;
    if (this.abuse.record(kind, now)) {
      this.deps.logger.warn('client_dropped_for_abuse', { session: this.id, ip: this.ip, counts: this.abuse.counts });
      this.close(1008, 'Protocol violation');
    }
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.transport.close(code, reason);
    this.onClose();
  }

  /** Transport closed (network drop or explicit close). */
  onClose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.room && this.member) this.room.handleDisconnect(this.member);
    this.room = null;
    this.member = null;
  }
}
