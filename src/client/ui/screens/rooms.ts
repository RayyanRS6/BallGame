import { MAX_PASSWORD_LENGTH } from '../../../shared/constants/game.ts';
import { normalizeRoomCode, type RoomSettingsInput } from '../../../shared/protocol/control.ts';
import { getMap } from '../../../shared/simulation/maps.ts';
import type { RoomListing } from '../../../shared/types/index.ts';
import { defaultRoomSettingsForClient } from '../../defaults.ts';
import { knownServers, normalizeServerUrl, probeAll, type ServerEntry } from '../../network/servers.ts';
import { settings } from '../../settings.ts';
import { button, field, h, select, textInput } from '../dom.ts';
import { roomSettingsForm } from '../room-settings-form.ts';
import { toast } from '../toast.ts';

function header(title: string, back: () => void, extra?: HTMLElement): HTMLElement {
  return h('div', { class: 'screen-header' }, button('← Back', back, 'btn ghost'), h('h1', null, title), h('span', { class: 'spacer' }), extra ?? null);
}

function serverSelect(onChange: (url: string) => void, includeAuto: boolean): HTMLSelectElement {
  const options = [...(includeAuto ? [{ value: 'auto', label: 'Automatic (lowest ping)' }] : []), ...knownServers().map((u) => ({ value: u, label: u }))];
  const pref = settings.get().network.preferredServer;
  const initial = options.some((o) => o.value === pref) ? pref : options[0]!.value;
  onChange(initial);
  return select(options, initial, onChange);
}

export function createRoomScreen(back: () => void, create: (server: string, input: RoomSettingsInput) => void): HTMLElement {
  let server = 'auto';
  const base = defaultRoomSettingsForClient();
  base.name = `${settings.get().profile.name}'s room`;
  const form = roomSettingsForm(base, { creating: true });
  return h(
    'div',
    { class: 'screen form-screen' },
    header('Create room', back),
    h('div', { class: 'card' }, field('Server', serverSelect((u) => (server = u), true), 'Pick the region closest to all players'), form.el),
    h('div', { class: 'screen-actions' }, button('Create room', () => create(server, form.value()), 'btn primary big')),
  );
}

export function joinRoomScreen(back: () => void, join: (server: string, code: string, password: string) => void, prefill = ''): HTMLElement {
  let server = 'auto';
  const code = textInput(prefill, { placeholder: 'AB7K', maxLength: 4 });
  code.classList.add('code-input');
  code.addEventListener('input', () => (code.value = code.value.toUpperCase()));
  const pw = textInput('', { type: 'password', placeholder: 'Only if the room has one', maxLength: MAX_PASSWORD_LENGTH });
  const submit = () => {
    const c = normalizeRoomCode(code.value);
    if (!c) {
      toast('Room codes are 4 characters (letters and digits 2–9)', 'error');
      return;
    }
    join(server, c, pw.value);
  };
  code.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  pw.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  setTimeout(() => code.focus(), 0);
  return h(
    'div',
    { class: 'screen form-screen narrow' },
    header('Join room', back),
    h('div', { class: 'card' }, field('Room code', code), field('Password', pw), field('Server', serverSelect((u) => (server = u), true), 'Room codes are unique per server')),
    h('div', { class: 'screen-actions' }, button('Join', submit, 'btn primary big')),
  );
}

export function browserScreen(back: () => void, join: (server: string, room: RoomListing) => void, createOn: (server: string) => void): HTMLElement {
  const tbody = h('tbody');
  const servers = h('div', { class: 'server-list' });
  const status = h('span', { class: 'muted small' }, 'Loading…');
  const addInput = textInput('', { placeholder: 'Add server: host:port or https://…' });

  const refresh = async () => {
    status.textContent = 'Measuring ping…';
    tbody.replaceChildren();
    servers.replaceChildren();
    const list: ServerEntry[] = await probeAll();
    status.textContent = `${list.filter((s) => s.online).length}/${list.length} servers online`;
    for (const s of list) {
      servers.append(
        h(
          'div',
          { class: `server-pill ${s.online ? 'online' : 'offline'}` },
          h('span', { class: `net-dot ${!s.online ? 'bad' : (s.ping ?? 999) < 80 ? 'good' : (s.ping ?? 999) < 160 ? 'ok' : 'bad'}` }),
          h('b', null, s.online ? s.region : 'offline'),
          ` ${s.online ? `${s.ping} ms · ${s.players} players` : s.error} · ${new URL(s.url).host}`,
          s.online ? button('New room here', () => createOn(s.url), 'btn tiny ghost') : null,
        ),
      );
      for (const r of s.rooms) {
        tbody.append(
          h(
            'tr',
            null,
            h('td', null, r.name),
            h('td', null, r.region),
            h('td', null, `${r.players}/${r.maxPlayers}`),
            h('td', null, `${s.ping} ms`),
            h('td', null, `${r.mode} · ${r.teamSize}v${r.teamSize}`),
            h('td', null, getMap(r.mapId).name),
            h('td', null, r.hasPassword ? '🔒' : ''),
            h('td', null, r.status),
            h('td', null, r.players >= r.maxPlayers ? h('span', { class: 'muted' }, 'Full') : button('Join', () => join(s.url, r), 'btn tiny primary')),
          ),
        );
      }
    }
    if (!tbody.childElementCount) tbody.append(h('tr', null, h('td', { colSpan: 9, class: 'muted center' }, 'No public rooms right now — create one!')));
  };
  void refresh();

  const add = () => {
    const url = normalizeServerUrl(addInput.value);
    if (!url) {
      toast('Invalid server address', 'error');
      return;
    }
    settings.update((s) => {
      if (!s.network.servers.includes(url)) s.network.servers.push(url);
    });
    addInput.value = '';
    void refresh();
  };

  return h(
    'div',
    { class: 'screen browser-screen' },
    header('Server browser', back, button('Refresh', () => void refresh(), 'btn')),
    h('div', { class: 'card' }, h('div', { class: 'row' }, status, h('span', { class: 'spacer' }), addInput, button('Add', add, 'btn small')), servers),
    h(
      'div',
      { class: 'card table-card' },
      h('table', { class: 'room-table' }, h('thead', null, h('tr', null, ...['Room', 'Region', 'Players', 'Ping', 'Mode', 'Map', '', 'Status', ''].map((t) => h('th', null, t)))), tbody),
    ),
  );
}
