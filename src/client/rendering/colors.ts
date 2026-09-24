import { TEAM_BLUE, TEAM_RED, type TeamId } from '../../shared/constants/game.ts';
import { settings } from '../settings.ts';

export interface TeamPalette {
  fill: string;
  light: string;
  dark: string;
  name: string;
}

const STANDARD: Record<1 | 2, TeamPalette> = {
  [TEAM_RED]: { fill: '#e5484d', light: '#ff9c9f', dark: '#7a1d20', name: 'Red' },
  [TEAM_BLUE]: { fill: '#3b82f6', light: '#9cc3ff', dark: '#173f86', name: 'Blue' },
};

/** Orange/blue pair distinguishable with protanopia, deuteranopia and tritanopia. */
const COLORBLIND: Record<1 | 2, TeamPalette> = {
  [TEAM_RED]: { fill: '#f59e0b', light: '#ffd27a', dark: '#7a4a00', name: 'Red' },
  [TEAM_BLUE]: { fill: '#2563eb', light: '#93b4ff', dark: '#0f2d78', name: 'Blue' },
};

export function teamPalette(team: TeamId): TeamPalette {
  const p = settings.get().accessibility.colorblind ? COLORBLIND : STANDARD;
  return team === TEAM_BLUE ? p[TEAM_BLUE] : p[TEAM_RED];
}

export function teamCssVars(): Record<string, string> {
  return {
    '--red': teamPalette(TEAM_RED).fill,
    '--blue': teamPalette(TEAM_BLUE).fill,
  };
}

export const PITCH = {
  background: '#0c1a14',
  outer: '#14352a',
  stripeA: '#1d5a3c',
  stripeB: '#205f40',
  line: 'rgba(240, 255, 245, 0.78)',
  net: 'rgba(235, 245, 255, 0.35)',
  post: '#f4f6fb',
};

export const PITCH_HIGH_CONTRAST = {
  background: '#000000',
  outer: '#0b2217',
  stripeA: '#0f3d26',
  stripeB: '#0f3d26',
  line: '#ffffff',
  net: 'rgba(255, 255, 255, 0.7)',
  post: '#ffffff',
};
