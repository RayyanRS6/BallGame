import { MAX_TEAM_SIZE } from '../../shared/constants/game.ts';
import { PHYSICS_PRESETS } from '../../shared/constants/physics-config.ts';
import type { RoomSettingsInput } from '../../shared/protocol/control.ts';
import { MAPS } from '../../shared/simulation/maps.ts';
import type { BotDifficulty, GameMode, RoomSettings } from '../../shared/types/index.ts';
import { checkbox, field, h, select, textInput } from './dom.ts';

export const TIME_OPTIONS = [
  { value: 60, label: '1 minute' },
  { value: 180, label: '3 minutes' },
  { value: 300, label: '5 minutes' },
  { value: 600, label: '10 minutes' },
  { value: 0, label: 'Unlimited' },
];

/**
 * Form for room/match settings, used both when creating a room and by the
 * host inside a room. Returns the element and a getter for the values.
 */
export function roomSettingsForm(initial: RoomSettings, opts: { creating: boolean; locked?: boolean }): { el: HTMLElement; value: () => RoomSettingsInput } {
  const v: RoomSettingsInput = {
    name: initial.name,
    isPublic: initial.isPublic,
    maxPlayers: initial.maxPlayers,
    allowSpectators: initial.allowSpectators,
    allowTeamSwitchDuringMatch: initial.allowTeamSwitchDuringMatch,
    aiTakeover: initial.aiTakeover,
    physicsPreset: initial.physicsPreset,
    botDifficulty: initial.botDifficulty,
    tickRate: initial.tickRate,
    match: { ...initial.match },
  };
  let password: string | undefined;
  let customPhysics: Record<string, unknown> | null = null;
  const m = v.match!;
  const customHint = h('span', { class: 'field-hint' }, 'Optional: paste JSON exported from the physics tuning panel (values are clamped by the server)');
  const customArea = h('textarea', { class: 'input', rows: 3, placeholder: '{ "kickForce": 280, "ballDamping": 0.5 }', spellcheck: false });
  customArea.addEventListener('input', () => {
    const text = customArea.value.trim();
    if (!text) {
      customPhysics = null;
      customHint.textContent = 'Optional: paste JSON exported from the physics tuning panel';
      return;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      customPhysics = parsed as Record<string, unknown>;
      customHint.textContent = `Custom physics: ${Object.keys(customPhysics).length} parameters`;
    } catch {
      customPhysics = null;
      customHint.textContent = 'Invalid JSON — ignored';
    }
  });
  if (opts.locked) customArea.disabled = true;
  const lock = (el: HTMLElement) => {
    if (opts.locked) (el as HTMLInputElement).disabled = true;
    return el;
  };

  const el = h(
    'div',
    { class: 'form-grid' },
    field('Room name', textInput(v.name ?? '', { maxLength: 32, onInput: (s) => (v.name = s) })),
    field(
      'Password',
      textInput('', { type: 'password', maxLength: 32, placeholder: initial.hasPassword ? '(unchanged — type to replace)' : 'none', onInput: (s) => (password = s) }),
      opts.creating ? 'Leave empty for an open room' : 'Type a new password; a single space removes it',
    ),
    field('Visibility', select([{ value: 'public', label: 'Public (server browser)' }, { value: 'private', label: 'Private (code only)' }], v.isPublic ? 'public' : 'private', (s) => (v.isPublic = s === 'public'))),
    field('Max players', select([2, 4, 6, 8, 10, 12, 16, 20].map((n) => ({ value: n, label: String(n) })), v.maxPlayers ?? 12, (n) => (v.maxPlayers = n))),
    field('Map', lock(select(MAPS.map((mp) => ({ value: mp.id, label: `${mp.name} (${mp.recommendedTeamSize}v${mp.recommendedTeamSize})` })), m.mapId ?? 'classic', (s) => (m.mapId = s)))),
    field('Team size', lock(select(Array.from({ length: MAX_TEAM_SIZE }, (_, i) => ({ value: i + 1, label: `${i + 1} v ${i + 1}` })), m.teamSize ?? 3, (n) => (m.teamSize = n)))),
    field('Match duration', lock(select(TIME_OPTIONS, m.timeLimit ?? 300, (n) => (m.timeLimit = n)))),
    field('Score limit', lock(select([0, 1, 3, 5, 7, 10].map((n) => ({ value: n, label: n ? `First to ${n}` : 'None' })), m.scoreLimit ?? 0, (n) => (m.scoreLimit = n)))),
    field(
      'Game mode',
      lock(
        select(
          [
            { value: 'classic', label: 'Classic' },
            { value: 'tournament', label: 'Tournament (series)' },
            { value: 'practice', label: 'Practice' },
          ] as { value: GameMode; label: string }[],
          m.mode ?? 'classic',
          (s) => (m.mode = s),
        ),
      ),
    ),
    field('Series length', lock(select([1, 3, 5].map((n) => ({ value: n, label: n === 1 ? 'Single match' : `Best of ${n}` })), m.rounds ?? 1, (n) => (m.rounds = n)))),
    field('Physics preset', lock(select(PHYSICS_PRESETS.map((p) => ({ value: p.id, label: p.name })), v.physicsPreset ?? 'classic', (s) => (v.physicsPreset = s)))),
    field('Bot difficulty', select([{ value: 'easy', label: 'Easy' }, { value: 'normal', label: 'Normal' }, { value: 'hard', label: 'Hard' }] as { value: BotDifficulty; label: string }[], v.botDifficulty ?? 'normal', (s) => (v.botDifficulty = s))),
    field('Kickoff countdown', lock(select([0, 1, 2, 3, 5].map((n) => ({ value: n, label: n ? `${n} s` : 'Off' })), m.countdownSeconds ?? 3, (n) => (m.countdownSeconds = n)))),
    field('Server tick rate', lock(select([{ value: 30, label: '30 Hz' }, { value: 60, label: '60 Hz' }, { value: 120, label: '120 Hz' }], v.tickRate ?? 60, (n) => (v.tickRate = n)))),
    h('label', { class: 'field wide' }, h('span', { class: 'field-label' }, 'Custom physics'), customArea, customHint),
    h(
      'div',
      { class: 'checks' },
      h('label', null, lock(checkbox(m.halftime ?? false, (b) => (m.halftime = b))), ' Half time'),
      h('label', null, lock(checkbox(m.overtime ?? true, (b) => (m.overtime = b))), ' Golden-goal overtime'),
      h('label', null, lock(checkbox(m.kickoffBarrier ?? true, (b) => (m.kickoffBarrier = b))), ' Kickoff barrier'),
      h('label', null, checkbox(v.allowSpectators ?? true, (b) => (v.allowSpectators = b)), ' Allow spectators'),
      h('label', null, checkbox(v.allowTeamSwitchDuringMatch ?? false, (b) => (v.allowTeamSwitchDuringMatch = b)), ' Team switching during matches'),
      h('label', null, checkbox(v.aiTakeover ?? false, (b) => (v.aiTakeover = b)), ' AI takes over disconnected players'),
    ),
  );
  if (opts.locked) el.prepend(h('p', { class: 'muted small' }, 'Match settings are locked while a match is running. Stop the match to change them.'));

  return {
    el,
    value: () => {
      const out: RoomSettingsInput = { ...v, match: { ...m } };
      if (password !== undefined && password !== '') out.password = password.trim();
      if (customPhysics) {
        out.physicsPreset = 'custom';
        out.customPhysics = customPhysics;
      }
      if (opts.locked) {
        delete out.match;
        delete out.physicsPreset;
        delete out.tickRate;
      }
      return out;
    },
  };
}
