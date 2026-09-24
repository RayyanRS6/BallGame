import { randomInt } from 'node:crypto';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../../shared/constants/game.ts';
import type { RoomSettingsInput } from '../../shared/protocol/control.ts';
import type { RoomListing } from '../../shared/types/index.ts';
import { Room, type RoomDeps, type RoomOptions } from './room.ts';

/** Owns every room on this server process. All state is in memory. */
export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private deps: RoomDeps;

  constructor(deps: RoomDeps) {
    this.deps = deps;
  }

  generateCode(): string {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('room code space exhausted');
  }

  createRoom(input: RoomSettingsInput, opts: RoomOptions = {}): Room | null {
    if (this.rooms.size >= this.deps.config.maxRooms) return null;
    const room = new Room(this.generateCode(), input, this.deps, opts);
    this.rooms.set(room.code, room);
    this.deps.logger.info('room_created', { room: room.code, name: room.settings.name, public: room.settings.isPublic, persistent: room.persistent });
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  destroyRoom(room: Room, reason: string): void {
    room.destroy(reason);
    this.rooms.delete(room.code);
    this.deps.logger.info('room_destroyed', { room: room.code, reason });
  }

  listPublic(): RoomListing[] {
    const out: RoomListing[] = [];
    for (const r of this.rooms.values()) if (r.settings.isPublic) out.push(r.listing(this.deps.config.region));
    return out.sort((a, b) => b.players - a.players || a.name.localeCompare(b.name));
  }

  get playerCount(): number {
    let n = 0;
    for (const r of this.rooms.values()) n += r.humanCount;
    return n;
  }

  /** Earliest time any room needs a tick. */
  nextDue(): number {
    let t = Infinity;
    for (const r of this.rooms.values()) if (r.nextDue < t) t = r.nextDue;
    return t;
  }

  advance(now: number): void {
    for (const r of this.rooms.values()) {
      try {
        r.advance(now);
      } catch (err) {
        // A bug in one room must never take down the process.
        this.deps.logger.error('room_crashed', { room: r.code, error: String((err as Error)?.stack ?? err) });
        this.destroyRoom(r, 'The room encountered an error and was closed');
      }
    }
  }

  /** Removes rooms that have been empty for too long. */
  sweep(now: number): void {
    for (const r of [...this.rooms.values()]) {
      if (r.persistent || r.humanCount > 0) continue;
      if (r.emptySince && now - r.emptySince >= this.deps.config.emptyRoomTimeoutMs) this.destroyRoom(r, 'empty');
    }
  }
}
