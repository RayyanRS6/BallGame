import { TEAM_BLUE, TEAM_RED, type PlayingTeam } from '../../../shared/constants/game.ts';
import { getPhysicsPreset, PHYSICS_PRESETS } from '../../../shared/constants/physics-config.ts';
import { MAPS } from '../../../shared/simulation/maps.ts';
import { DEFAULT_MATCH_SETTINGS } from '../../../shared/simulation/settings.ts';
import type { BotDifficulty, MatchSettings } from '../../../shared/types/index.ts';
import type { LocalOptions, LocalSlot } from '../../game/local-session.ts';
import { settings } from '../../settings.ts';
import { button, checkbox, field, h, select } from '../dom.ts';
import { TIME_OPTIONS } from '../room-settings-form.ts';

type LocalMode = 'bots' | 'versus' | 'coop' | 'tournament' | 'practice';

const BOT_NAMES = ['Atlas', 'Bolt', 'Comet', 'Dash', 'Echo', 'Flux', 'Gale', 'Hex', 'Ion', 'Jet', 'Kite', 'Lux', 'Mako', 'Nova', 'Orbit', 'Pulse'];

export function buildLocalOptions(mode: LocalMode, teamSize: number, myTeam: PlayingTeam, difficulty: BotDifficulty, match: MatchSettings, presetId: string): LocalOptions {
  const profile = settings.get().profile;
  const slots: LocalSlot[] = [];
  let id = 1;
  const humans: { team: PlayingTeam; control: 'p1' | 'p2'; name: string; avatar: string }[] = [
    { team: myTeam, control: 'p1', name: profile.name, avatar: profile.avatar },
  ];
  if (mode === 'versus') humans.push({ team: myTeam === TEAM_RED ? TEAM_BLUE : TEAM_RED, control: 'p2', name: 'Player 2', avatar: 'P2' });
  if (mode === 'coop') humans.push({ team: myTeam, control: 'p2', name: 'Player 2', avatar: 'P2' });
  for (const team of [TEAM_RED, TEAM_BLUE] as const) {
    const mine = humans.filter((x) => x.team === team);
    for (const hmn of mine) slots.push({ id: id++, team, control: hmn.control, name: hmn.name, avatar: hmn.avatar, difficulty });
    for (let i = mine.length; i < teamSize; i++) {
      const n = BOT_NAMES[(id * 7) % BOT_NAMES.length]!;
      slots.push({ id: id++, team, control: 'bot', name: n, avatar: n.slice(0, 1), difficulty });
    }
  }
  const settingsOut: MatchSettings = {
    ...match,
    mode: mode === 'tournament' ? 'tournament' : mode === 'practice' ? 'practice' : 'classic',
    teamSize,
    returnToLobby: false,
    rounds: mode === 'tournament' ? Math.max(3, match.rounds) : 1,
  };
  const title = mode === 'tournament' ? `Tournament ${teamSize}v${teamSize}` : mode === 'practice' ? 'Practice' : mode === 'versus' ? `Local versus ${teamSize}v${teamSize}` : `${teamSize}v${teamSize} vs bots`;
  return {
    mode: mode === 'practice' ? 'practice' : 'match',
    title,
    settings: settingsOut,
    physics: { ...getPhysicsPreset(presetId).config },
    slots,
    tickRate: 60,
  };
}

export function localSetupScreen(back: () => void, start: (opts: LocalOptions) => void): HTMLElement {
  let mode: LocalMode = 'bots';
  let teamSize = 2;
  let myTeam: PlayingTeam = TEAM_RED;
  let difficulty: BotDifficulty = 'normal';
  let preset = settings.get().gameplay.physicsPreset;
  const match: MatchSettings = { ...DEFAULT_MATCH_SETTINGS, timeLimit: 180, mapId: 'classic' };

  return h(
    'div',
    { class: 'screen form-screen' },
    h('div', { class: 'screen-header' }, button('← Back', back, 'btn ghost'), h('h1', null, 'Local match')),
    h(
      'div',
      { class: 'card form-grid' },
      field(
        'Mode',
        select(
          [
            { value: 'bots', label: 'You vs bots' },
            { value: 'versus', label: '2 players, versus (same device)' },
            { value: 'coop', label: '2 players, same team vs bots' },
            { value: 'tournament', label: 'Tournament series vs bots' },
            { value: 'practice', label: 'Practice (live physics tuning)' },
          ] as { value: LocalMode; label: string }[],
          mode,
          (v) => (mode = v),
        ),
        'P1: WASD + Space (or pad 1) · P2: Arrows + Enter (or pad 2)',
      ),
      field('Team size', select([1, 2, 3, 4, 5].map((n) => ({ value: n, label: `${n} v ${n}` })), teamSize, (v) => (teamSize = v))),
      field('Your team', select([{ value: TEAM_RED, label: 'Red' }, { value: TEAM_BLUE, label: 'Blue' }] as { value: PlayingTeam; label: string }[], myTeam, (v) => (myTeam = v))),
      field('Bot difficulty', select([{ value: 'easy', label: 'Easy' }, { value: 'normal', label: 'Normal' }, { value: 'hard', label: 'Hard' }] as { value: BotDifficulty; label: string }[], difficulty, (v) => (difficulty = v))),
      field('Map', select(MAPS.map((m) => ({ value: m.id, label: m.name })), match.mapId, (v) => (match.mapId = v))),
      field('Duration', select(TIME_OPTIONS, match.timeLimit, (v) => (match.timeLimit = v))),
      field('Score limit', select([0, 1, 3, 5, 7, 10].map((n) => ({ value: n, label: n ? `First to ${n}` : 'None' })), match.scoreLimit, (v) => (match.scoreLimit = v))),
      field('Tournament length', select([3, 5, 7].map((n) => ({ value: n, label: `Best of ${n}` })), 3, (v) => (match.rounds = v))),
      field('Physics', select(PHYSICS_PRESETS.map((p) => ({ value: p.id, label: `${p.name} — ${p.description}` })), preset, (v) => (preset = v))),
      h(
        'div',
        { class: 'checks' },
        h('label', null, checkbox(match.halftime, (b) => (match.halftime = b)), ' Half time'),
        h('label', null, checkbox(match.overtime, (b) => (match.overtime = b)), ' Golden-goal overtime'),
        h('label', null, checkbox(match.kickoffBarrier, (b) => (match.kickoffBarrier = b)), ' Kickoff barrier'),
      ),
    ),
    h('div', { class: 'screen-actions' }, button('Start', () => start(buildLocalOptions(mode, teamSize, myTeam, difficulty, match, preset)), 'btn primary big')),
  );
}
