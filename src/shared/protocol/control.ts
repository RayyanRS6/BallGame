/**
 * JSON control messages (reliable, low frequency): lobby, rooms, chat,
 * settings, match results. Everything received from a client goes through
 * `parseClientControl`, which rejects anything malformed.
 */
import type { PhysicsConfig } from '../constants/physics-config.ts';
import {
  MAX_AVATAR_LENGTH,
  MAX_CHAT_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_ROOM_NAME_LENGTH,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  type PlayingTeam,
  type TeamId,
} from '../constants/game.ts';
import type { BotDifficulty, MatchSettings, MatchStats, RoomSettings, RosterEntry } from '../types/index.ts';

export const MAX_CONTROL_BYTES = 8192;

export interface ServerInfo {
  name: string;
  region: string;
  version: string;
}

export interface RoomSettingsInput {
  name?: string;
  password?: string;
  maxPlayers?: number;
  isPublic?: boolean;
  allowSpectators?: boolean;
  allowTeamSwitchDuringMatch?: boolean;
  aiTakeover?: boolean;
  physicsPreset?: string;
  customPhysics?: Partial<PhysicsConfig> | null;
  botDifficulty?: BotDifficulty;
  tickRate?: number;
  match?: Partial<MatchSettings>;
}

export type ClientControl =
  | { t: 'hello'; v: number; name: string; avatar: string }
  | { t: 'create'; room: RoomSettingsInput }
  | { t: 'join'; code: string; password: string }
  | { t: 'rejoin'; code: string; token: string }
  | { t: 'leave' }
  | { t: 'team'; team: TeamId; playerId?: number }
  | { t: 'settings'; room: RoomSettingsInput }
  | { t: 'start' }
  | { t: 'stop' }
  | { t: 'addBot'; team: PlayingTeam }
  | { t: 'removeBot'; playerId: number }
  | { t: 'kick'; playerId: number; ban: boolean }
  | { t: 'chat'; text: string }
  | { t: 'profile'; name: string; avatar: string }
  | { t: 'getReplay' };

export interface RoomInfo {
  code: string;
  settings: RoomSettings;
  physics: PhysicsConfig;
  configVersion: number;
}

export type ErrorCode =
  | 'room_not_found'
  | 'room_full'
  | 'bad_password'
  | 'bad_request'
  | 'rate_limited'
  | 'not_host'
  | 'team_locked'
  | 'team_full'
  | 'server_full'
  | 'version_mismatch'
  | 'reconnect_failed'
  | 'banned'
  | 'not_in_room'
  | 'no_replay';

export type ServerControl =
  | { t: 'welcome'; server: ServerInfo; protocol: number }
  | { t: 'joined'; code: string; playerId: number; token: string; room: RoomInfo; rejoined: boolean }
  | { t: 'room'; room: RoomInfo }
  | { t: 'roster'; players: RosterEntry[]; hostId: number }
  | { t: 'chat'; from: number; name: string; text: string; system: boolean }
  | { t: 'goal'; team: PlayingTeam; scorerId: number; assistId: number; ownGoal: boolean; scoreRed: number; scoreBlue: number }
  | { t: 'matchEnd'; winner: TeamId; scoreRed: number; scoreBlue: number; stats: MatchStats; seriesOver: boolean; replayAvailable: boolean }
  | { t: 'stats'; stats: MatchStats }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'left'; reason: string };

// ------------------------------------------------------------------ sanitising

// Control characters, bidi overrides and zero-width characters.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g;

export function sanitizeText(input: unknown, maxLength: number): string {
  if (typeof input !== 'string') return '';
  return [...input.replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim()].slice(0, maxLength).join('');
}

export function sanitizeName(input: unknown): string {
  return sanitizeText(input, MAX_NAME_LENGTH) || 'Player';
}

export function sanitizeAvatar(input: unknown): string {
  return sanitizeText(input, MAX_AVATAR_LENGTH).replace(/\s/g, '');
}

export function normalizeRoomCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const code = input.trim().toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

// ------------------------------------------------------------------ parsing

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

function parseRoomInput(v: unknown): RoomSettingsInput | null {
  if (!isObj(v)) return null;
  const out: RoomSettingsInput = {};
  if (v.name !== undefined) out.name = sanitizeText(v.name, MAX_ROOM_NAME_LENGTH);
  if (v.password !== undefined) {
    if (typeof v.password !== 'string' || v.password.length > MAX_PASSWORD_LENGTH) return null;
    out.password = v.password;
  }
  if (v.maxPlayers !== undefined) {
    if (!isInt(v.maxPlayers, 2, 32)) return null;
    out.maxPlayers = v.maxPlayers;
  }
  for (const key of ['isPublic', 'allowSpectators', 'allowTeamSwitchDuringMatch', 'aiTakeover'] as const) {
    if (v[key] !== undefined) {
      if (typeof v[key] !== 'boolean') return null;
      out[key] = v[key] as boolean;
    }
  }
  if (v.physicsPreset !== undefined) {
    if (typeof v.physicsPreset !== 'string' || v.physicsPreset.length > 24) return null;
    out.physicsPreset = v.physicsPreset;
  }
  if (v.customPhysics !== undefined) {
    if (v.customPhysics !== null && !isObj(v.customPhysics)) return null;
    out.customPhysics = v.customPhysics as Partial<PhysicsConfig> | null;
  }
  if (v.botDifficulty !== undefined) {
    if (v.botDifficulty !== 'easy' && v.botDifficulty !== 'normal' && v.botDifficulty !== 'hard') return null;
    out.botDifficulty = v.botDifficulty;
  }
  if (v.tickRate !== undefined) {
    if (v.tickRate !== 30 && v.tickRate !== 60 && v.tickRate !== 120) return null;
    out.tickRate = v.tickRate;
  }
  if (v.match !== undefined) {
    if (!isObj(v.match)) return null;
    out.match = v.match as Partial<MatchSettings>; // clamped by sanitizeMatchSettings on the server
  }
  return out;
}

/** Parses and validates a client control message. Returns null when invalid. */
export function parseClientControl(text: string): ClientControl | null {
  if (text.length > MAX_CONTROL_BYTES) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(v) || typeof v.t !== 'string') return null;
  switch (v.t) {
    case 'hello':
      if (!isInt(v.v, 0, 1_000_000)) return null;
      return { t: 'hello', v: v.v, name: sanitizeName(v.name), avatar: sanitizeAvatar(v.avatar) };
    case 'create': {
      const room = parseRoomInput(v.room);
      return room ? { t: 'create', room } : null;
    }
    case 'join': {
      const code = normalizeRoomCode(v.code);
      if (!code) return null;
      const password = v.password === undefined ? '' : v.password;
      if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) return null;
      return { t: 'join', code, password };
    }
    case 'rejoin': {
      const code = normalizeRoomCode(v.code);
      if (!code || typeof v.token !== 'string' || !/^[0-9a-f]{32}$/.test(v.token)) return null;
      return { t: 'rejoin', code, token: v.token };
    }
    case 'leave':
    case 'start':
    case 'stop':
    case 'getReplay':
      return { t: v.t };
    case 'team':
      if (!isInt(v.team, 0, 2)) return null;
      if (v.playerId !== undefined && !isInt(v.playerId, 1, 255)) return null;
      return { t: 'team', team: v.team as TeamId, playerId: v.playerId as number | undefined };
    case 'settings': {
      const room = parseRoomInput(v.room);
      return room ? { t: 'settings', room } : null;
    }
    case 'addBot':
      if (v.team !== 1 && v.team !== 2) return null;
      return { t: 'addBot', team: v.team };
    case 'removeBot':
      if (!isInt(v.playerId, 1, 255)) return null;
      return { t: 'removeBot', playerId: v.playerId };
    case 'kick':
      if (!isInt(v.playerId, 1, 255)) return null;
      return { t: 'kick', playerId: v.playerId, ban: v.ban === true };
    case 'chat': {
      const text = sanitizeText(v.text, MAX_CHAT_LENGTH);
      return text ? { t: 'chat', text } : null;
    }
    case 'profile':
      return { t: 'profile', name: sanitizeName(v.name), avatar: sanitizeAvatar(v.avatar) };
    default:
      return null;
  }
}

/** Client side: parse a server control message (trusted but still defensive). */
export function parseServerControl(text: string): ServerControl | null {
  try {
    const v = JSON.parse(text) as unknown;
    if (!isObj(v) || typeof v.t !== 'string') return null;
    return v as unknown as ServerControl;
  } catch {
    return null;
  }
}
