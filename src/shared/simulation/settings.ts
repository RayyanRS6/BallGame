import { MAX_TEAM_SIZE } from '../constants/game.ts';
import type { GameMode, MatchSettings } from '../types/index.ts';
import { MAPS } from './maps.ts';

export const TIME_LIMIT_OPTIONS = [60, 180, 300, 600, 0] as const;
export const ROUND_OPTIONS = [1, 3, 5] as const;
const MODES: readonly GameMode[] = ['classic', 'training', 'tournament', 'practice'];

export const DEFAULT_MATCH_SETTINGS: Readonly<MatchSettings> = Object.freeze({
  mode: 'classic',
  timeLimit: 300,
  scoreLimit: 0,
  teamSize: 3,
  halftime: false,
  overtime: true,
  countdownSeconds: 3,
  goalPauseSeconds: 2,
  rounds: 1,
  kickoffBarrier: true,
  returnToLobby: true,
  mapId: 'classic',
});

export function trainingSettings(mapId = 'classic'): MatchSettings {
  return {
    ...DEFAULT_MATCH_SETTINGS,
    mode: 'training',
    timeLimit: 0,
    scoreLimit: 0,
    teamSize: MAX_TEAM_SIZE,
    halftime: false,
    overtime: false,
    countdownSeconds: 0,
    goalPauseSeconds: 1,
    kickoffBarrier: false,
    returnToLobby: false,
    mapId,
  };
}

function int(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** Validates untrusted match settings, clamping every field. */
export function sanitizeMatchSettings(input: unknown, base: MatchSettings = DEFAULT_MATCH_SETTINGS): MatchSettings {
  const src = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const mode = MODES.includes(src.mode as GameMode) ? (src.mode as GameMode) : base.mode;
  const mapId = typeof src.mapId === 'string' && MAPS.some((m) => m.id === src.mapId) ? src.mapId : base.mapId;
  return {
    mode,
    timeLimit: int(src.timeLimit, 0, 3600, base.timeLimit),
    scoreLimit: int(src.scoreLimit, 0, 99, base.scoreLimit),
    teamSize: int(src.teamSize, 1, MAX_TEAM_SIZE, base.teamSize),
    halftime: bool(src.halftime, base.halftime),
    overtime: bool(src.overtime, base.overtime),
    countdownSeconds: int(src.countdownSeconds, 0, 5, base.countdownSeconds),
    goalPauseSeconds: int(src.goalPauseSeconds, 1, 5, base.goalPauseSeconds),
    rounds: int(src.rounds, 1, 9, base.rounds) | 1, // always odd
    kickoffBarrier: bool(src.kickoffBarrier, base.kickoffBarrier),
    returnToLobby: bool(src.returnToLobby, base.returnToLobby),
    mapId,
  };
}
