import type { MatchPhase, PlayingTeam, TeamId } from '../constants/game.ts';

export interface Vector2 {
  x: number;
  y: number;
}

/**
 * The single input representation used by keyboard, gamepad, touch, bots and
 * the network. Axes are quantised to integers in [-127, 127]; the simulation
 * normalises vectors longer than 1 so diagonals are never faster.
 */
export interface InputState {
  x: number;
  y: number;
  kick: boolean;
}

/** An input as sent over the network, stamped with a sequence number. */
export interface PlayerInput extends InputState {
  sequence: number;
}

export type GameMode = 'classic' | 'training' | 'tournament' | 'practice';

export interface MatchSettings {
  mode: GameMode;
  /** Seconds, 0 = unlimited. */
  timeLimit: number;
  /** Goals needed to win, 0 = no limit. */
  scoreLimit: number;
  /** Maximum players per team. */
  teamSize: number;
  /** Pause at half time and alternate the kickoff. */
  halftime: boolean;
  /** Golden-goal overtime when tied at full time. */
  overtime: boolean;
  countdownSeconds: number;
  goalPauseSeconds: number;
  /** Best-of-N series (tournament). 1 = single match. */
  rounds: number;
  /** Keep the defending team out of the centre circle until the ball is touched. */
  kickoffBarrier: boolean;
  /** Return to LOBBY after the match-end celebration (online rooms). */
  returnToLobby: boolean;
  mapId: string;
}

export interface PlayerStateData {
  id: number;
  team: PlayingTeam;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ix: number;
  iy: number;
  kick: boolean;
  kickLatch: boolean;
  cooldown: number;
  /** In contact with the ball (touch statistics). */
  touching: boolean;
}

export interface BallStateData {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
}

export interface MatchStateData {
  phase: MatchPhase;
  phaseTicks: number;
  scoreRed: number;
  scoreBlue: number;
  /** Ticks of played time (runs only while PLAYING). */
  timeTicks: number;
  kickoffTeam: PlayingTeam;
  firstKickoffTeam: PlayingTeam;
  kickoffActive: boolean;
  overtime: boolean;
  /** A goal/timeout ended the match; transition to MATCH_END after the pause. */
  matchOver: boolean;
  half: number;
  round: number;
  roundWinsRed: number;
  roundWinsBlue: number;
  /** Warm-up / training: ticks until the ball is re-spawned after a goal. */
  ballResetTicks: number;
  lastTouchId: number;
  prevTouchId: number;
}

export interface SimStateData {
  tick: number;
  rng: number;
  players: PlayerStateData[];
  ball: BallStateData;
  match: MatchStateData;
}

export interface PlayerStats {
  id: number;
  goals: number;
  assists: number;
  ownGoals: number;
  shots: number;
  kicks: number;
  touches: number;
}

export interface MatchStats {
  players: PlayerStats[];
  possessionRed: number;
  possessionBlue: number;
}

export interface RosterEntry {
  id: number;
  name: string;
  avatar: string;
  team: TeamId;
  isBot: boolean;
  isHost: boolean;
  ping: number;
  status: 'connected' | 'reconnecting' | 'ai';
}

export interface RoomSettings {
  name: string;
  isPublic: boolean;
  hasPassword: boolean;
  maxPlayers: number;
  allowSpectators: boolean;
  allowTeamSwitchDuringMatch: boolean;
  aiTakeover: boolean;
  physicsPreset: string;
  tickRate: number;
  snapshotRate: number;
  botDifficulty: BotDifficulty;
  match: MatchSettings;
}

export type BotDifficulty = 'easy' | 'normal' | 'hard';

export interface RoomListing {
  code: string;
  name: string;
  region: string;
  players: number;
  maxPlayers: number;
  mode: GameMode;
  mapId: string;
  hasPassword: boolean;
  status: 'lobby' | 'playing';
  teamSize: number;
}
