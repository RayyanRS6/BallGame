import { DEFAULT_TICK_RATE } from '../shared/constants/game.ts';
import { DEFAULT_MATCH_SETTINGS } from '../shared/simulation/settings.ts';
import type { RoomSettings } from '../shared/types/index.ts';

/** Initial values for the "create room" form (the server validates everything). */
export function defaultRoomSettingsForClient(): RoomSettings {
  return {
    name: 'Room',
    isPublic: true,
    hasPassword: false,
    maxPlayers: 12,
    allowSpectators: true,
    allowTeamSwitchDuringMatch: false,
    aiTakeover: false,
    physicsPreset: 'classic',
    tickRate: DEFAULT_TICK_RATE,
    snapshotRate: DEFAULT_TICK_RATE,
    botDifficulty: 'normal',
    match: { ...DEFAULT_MATCH_SETTINGS },
  };
}
