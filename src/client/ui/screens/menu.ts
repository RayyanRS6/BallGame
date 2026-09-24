import { GAME_VERSION, MAX_AVATAR_LENGTH, MAX_NAME_LENGTH } from '../../../shared/constants/game.ts';
import { sanitizeAvatar, sanitizeName } from '../../../shared/protocol/control.ts';
import { probeAll, type ServerEntry } from '../../network/servers.ts';
import { settings } from '../../settings.ts';
import { button, field, h, setText, textInput } from '../dom.ts';

export interface MenuActions {
  play(): void;
  createRoom(): void;
  joinRoom(): void;
  browser(): void;
  local(): void;
  training(): void;
  replays(): void;
  settings(): void;
}

export function menuScreen(actions: MenuActions): HTMLElement {
  const p = settings.get().profile;
  const name = textInput(p.name, {
    maxLength: MAX_NAME_LENGTH,
    placeholder: 'Your name',
    onInput: (v) => settings.update((s) => (s.profile.name = sanitizeName(v))),
  });
  const avatar = textInput(p.avatar, {
    maxLength: MAX_AVATAR_LENGTH,
    placeholder: 'e.g. 10',
    onInput: (v) => settings.update((s) => (s.profile.avatar = sanitizeAvatar(v))),
  });
  avatar.classList.add('avatar-input');

  const serverStatus = h('div', { class: 'server-status muted small' }, 'Checking servers…');
  void probeAll().then((list: ServerEntry[]) => {
    const online = list.filter((s) => s.online);
    if (!online.length) setText(serverStatus, 'No game server reachable — offline modes are available.');
    else {
      const best = online[0]!;
      setText(serverStatus, `${online.length} server${online.length > 1 ? 's' : ''} online · best: ${best.region} (${best.ping} ms) · ${online.reduce((n, s) => n + s.players, 0)} players`);
    }
  });

  const nav = h(
    'nav',
    { class: 'menu-nav' },
    button('Play', actions.play, 'btn primary big'),
    button('Create room', actions.createRoom, 'btn big'),
    button('Join room', actions.joinRoom, 'btn big'),
    button('Server browser', actions.browser, 'btn big'),
    button('Local match', actions.local, 'btn big'),
    button('Training', actions.training, 'btn big'),
    button('Replays', actions.replays, 'btn big'),
    button('Settings', actions.settings, 'btn big'),
  );

  return h(
    'div',
    { class: 'screen menu-screen' },
    h(
      'div',
      { class: 'menu-left' },
      h('div', { class: 'logo' }, h('span', { class: 'logo-ball' }), h('span', null, 'MOMENTUM')),
      h('div', { class: 'tagline' }, 'Physics football. Every touch is an impulse.'),
      nav,
    ),
    h(
      'div',
      { class: 'menu-right' },
      h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Profile'), field('Name', name), field('Avatar', avatar, 'Up to 2 characters shown on your player')),
      h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Servers'), serverStatus),
      h(
        'div',
        { class: 'card controls-card' },
        h('div', { class: 'card-title' }, 'Controls'),
        h('div', { class: 'kv' }, h('span', null, 'Move'), h('span', null, 'WASD / Arrow keys / Left stick / Touch stick')),
        h('div', { class: 'kv' }, h('span', null, 'Kick'), h('span', null, 'Space / X / A (Cross) — hold to kick on contact')),
        h('div', { class: 'kv' }, h('span', null, 'Menu'), h('span', null, 'Esc / Start')),
        h('div', { class: 'kv' }, h('span', null, 'Chat'), h('span', null, 'Enter (online)')),
        h('div', { class: 'kv' }, h('span', null, 'Debug'), h('span', null, 'F3 or `')),
      ),
      h('div', { class: 'muted small version' }, `v${GAME_VERSION} · deterministic 120 Hz physics · original assets`),
    ),
  );
}
