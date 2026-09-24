/** Versioning — bump when the wire format / simulation semantics change. */
export const GAME_VERSION = '1.0.0';
export const PROTOCOL_VERSION = 1;
/** Replays are only reproducible with the same physics implementation version. */
export const PHYSICS_VERSION = 1;

/**
 * The physics integrator always advances in steps of 1/SUBSTEP_HZ seconds.
 * A simulation tick is an integer number of substeps, so physics behaves the
 * same at every supported tick rate — only input sampling granularity (and
 * float32 rounding at tick boundaries) changes.
 */
export const SUBSTEP_HZ = 120;
export const SUPPORTED_TICK_RATES = [30, 60, 120] as const;
export const DEFAULT_TICK_RATE = 60;

/** Team identifiers (numeric so they fit in one byte on the wire). */
export const TEAM_SPECTATOR = 0;
export const TEAM_RED = 1;
export const TEAM_BLUE = 2;
export type TeamId = 0 | 1 | 2;
export type PlayingTeam = 1 | 2;
export const TEAM_NAMES = ['Spectators', 'Red', 'Blue'] as const;

export function otherTeam(team: PlayingTeam): PlayingTeam {
  return team === TEAM_RED ? TEAM_BLUE : TEAM_RED;
}

/** Match phases of the authoritative state machine. */
export const PHASE_LOBBY = 0;
export const PHASE_COUNTDOWN = 1;
export const PHASE_PLAYING = 2;
export const PHASE_GOAL_PAUSE = 3;
export const PHASE_HALFTIME = 4;
export const PHASE_MATCH_END = 5;
export const PHASE_RESETTING = 6;
export type MatchPhase = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const PHASE_NAMES = ['LOBBY', 'COUNTDOWN', 'PLAYING', 'GOAL_PAUSE', 'HALFTIME', 'MATCH_END', 'RESETTING'] as const;

/** Quantised analog input range: axes are integers in [-AXIS_MAX, AXIS_MAX]. */
export const AXIS_MAX = 127;

/** Collision categories (bit flags). */
export const CAT_BALL = 1;
export const CAT_RED = 2;
export const CAT_BLUE = 4;
export const CAT_PLAYER = CAT_RED | CAT_BLUE;
export const CAT_ALL = 0xff;

/** Tags of static colliders (used for events, sounds and debug drawing). */
export const TAG_WALL = 1;
export const TAG_POST = 2;
export const TAG_NET = 3;
export const TAG_BARRIER = 4;
export const TAG_OUTER = 5;

/** Limits shared by client and server validation. */
export const MAX_NAME_LENGTH = 20;
export const MAX_AVATAR_LENGTH = 2;
export const MAX_CHAT_LENGTH = 140;
export const MAX_ROOM_NAME_LENGTH = 32;
export const MAX_PASSWORD_LENGTH = 32;
export const MAX_ROOM_PLAYERS = 32;
export const MAX_TEAM_SIZE = 8;
export const ROOM_CODE_LENGTH = 4;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Number of past inputs repeated in every input packet (loss resilience). */
export const INPUT_REDUNDANCY = 6;
