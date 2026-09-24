import { TEAM_RED, type PlayingTeam } from '../constants/game.ts';
import type { MapDef } from './maps.ts';

/**
 * Kickoff formations for the red team, as fractions of (halfWidth, halfHeight).
 * Blue mirrors them horizontally. Every slot lies in the team's own half and
 * outside the centre circle on all built-in maps.
 */
const FORMATIONS: readonly (readonly (readonly [number, number])[])[] = [
  [],
  [[-0.45, 0]],
  [[-0.42, -0.28], [-0.42, 0.28]],
  [[-0.32, 0], [-0.6, -0.42], [-0.6, 0.42]],
  [[-0.3, -0.28], [-0.3, 0.28], [-0.62, -0.45], [-0.62, 0.45]],
  [[-0.26, 0], [-0.45, -0.5], [-0.45, 0.5], [-0.7, -0.22], [-0.7, 0.22]],
  [[-0.26, -0.3], [-0.26, 0.3], [-0.5, 0], [-0.52, -0.6], [-0.52, 0.6], [-0.8, 0]],
];

/** Returns the kickoff position of slot `index` in a team of `count` players. */
export function formationPosition(map: MapDef, team: PlayingTeam, index: number, count: number): { x: number; y: number } {
  const side = team === TEAM_RED ? 1 : -1;
  let fx: number;
  let fy: number;
  const table = FORMATIONS[count];
  if (table && index < table.length) {
    fx = table[index]![0];
    fy = table[index]![1];
  } else {
    // Generic grid for large teams: columns of up to 4 players.
    const perCol = 4;
    const col = Math.floor(index / perCol);
    const row = index % perCol;
    const rows = Math.min(perCol, count - col * perCol);
    fx = -0.25 - col * 0.18;
    fy = rows > 1 ? -0.6 + (1.2 * row) / (rows - 1) : 0;
  }
  return { x: fx * map.halfWidth * side, y: fy * map.halfHeight };
}
