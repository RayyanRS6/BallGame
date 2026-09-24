import { TEAM_BLUE, TEAM_RED, type TeamId } from '../../shared/constants/game.ts';
import type { MatchStats } from '../../shared/types/index.ts';
import { teamPalette } from '../rendering/colors.ts';
import { h } from './dom.ts';

export interface SummaryPlayer {
  id: number;
  name: string;
  team: TeamId;
}

/** Final score, winner, possession bar and per-player statistics table. */
export function matchSummary(winner: TeamId, scoreRed: number, scoreBlue: number, stats: MatchStats, players: SummaryPlayer[]): HTMLDivElement {
  const red = teamPalette(TEAM_RED);
  const blue = teamPalette(TEAM_BLUE);
  const title = winner === TEAM_RED ? `${red.name} wins` : winner === TEAM_BLUE ? `${blue.name} wins` : 'Draw';
  const total = stats.possessionRed + stats.possessionBlue;
  const redPct = total > 0 ? Math.round((stats.possessionRed / total) * 100) : 50;

  const rows = players
    .filter((p) => p.team === TEAM_RED || p.team === TEAM_BLUE || stats.players.some((s) => s.id === p.id))
    .map((p) => {
      const s = stats.players.find((x) => x.id === p.id);
      const color = p.team === TEAM_BLUE ? blue.fill : red.fill;
      return h(
        'tr',
        null,
        h('td', null, h('span', { class: 'dot', style: { background: color } }), p.name),
        h('td', null, String(s?.goals ?? 0)),
        h('td', null, String(s?.assists ?? 0)),
        h('td', null, String(s?.ownGoals ?? 0)),
        h('td', null, String(s?.shots ?? 0)),
        h('td', null, String(s?.kicks ?? 0)),
        h('td', null, String(s?.touches ?? 0)),
      );
    });

  return h(
    'div',
    { class: 'summary' },
    h('div', { class: 'summary-title', style: { color: winner === TEAM_BLUE ? blue.fill : winner === TEAM_RED ? red.fill : '#fff' } }, title),
    h('div', { class: 'summary-score' }, h('span', { style: { color: red.fill } }, String(scoreRed)), ' — ', h('span', { style: { color: blue.fill } }, String(scoreBlue))),
    h(
      'div',
      { class: 'possession' },
      h('div', { class: 'possession-label' }, `Possession ${redPct}% — ${100 - redPct}%`),
      h('div', { class: 'possession-bar' }, h('div', { style: { width: `${redPct}%`, background: red.fill } }), h('div', { style: { width: `${100 - redPct}%`, background: blue.fill } })),
    ),
    h(
      'table',
      { class: 'stats-table' },
      h('thead', null, h('tr', null, ...['Player', 'G', 'A', 'OG', 'Shots', 'Kicks', 'Touches'].map((t) => h('th', null, t)))),
      h('tbody', null, ...rows),
    ),
  );
}
