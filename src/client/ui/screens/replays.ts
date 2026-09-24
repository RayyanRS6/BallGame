import { decodeReplay, type ReplayData } from '../../../shared/simulation/replay.ts';
import { deleteReplay, listReplays, loadReplayBytes } from '../../replays.ts';
import { button, downloadBlob, h } from '../dom.ts';
import { formatClock } from '../hud.ts';
import { toast } from '../toast.ts';

export function replaysScreen(back: () => void, watch: (data: ReplayData) => void): HTMLElement {
  const tbody = h('tbody');
  const open = (bytes: Uint8Array | null) => {
    if (!bytes) return toast('Replay data missing', 'error');
    try {
      watch(decodeReplay(bytes));
    } catch (e) {
      toast(`Cannot play replay: ${(e as Error).message}`, 'error');
    }
  };
  const render = () => {
    tbody.replaceChildren();
    const list = listReplays();
    if (!list.length) tbody.append(h('tr', null, h('td', { colSpan: 5, class: 'muted center' }, 'No saved replays yet. Finish a match and choose “Save replay”.')));
    for (const r of list) {
      tbody.append(
        h(
          'tr',
          null,
          h('td', null, r.title),
          h('td', null, new Date(r.recordedAt).toLocaleString()),
          h('td', null, formatClock(r.durationSec)),
          h('td', null, `${r.scoreRed} – ${r.scoreBlue}`),
          h(
            'td',
            { class: 'row-actions' },
            button('Watch', () => open(loadReplayBytes(r.id)), 'btn tiny primary'),
            button('Download', () => {
              const b = loadReplayBytes(r.id);
              if (b) downloadBlob(b, `${r.title.replace(/[^\w-]+/g, '_')}.mfr`, 'application/octet-stream');
            }, 'btn tiny'),
            button('Delete', () => {
              deleteReplay(r.id);
              render();
            }, 'btn tiny danger ghost'),
          ),
        ),
      );
    }
  };
  render();

  const file = h('input', { type: 'file', accept: '.mfr,application/octet-stream', class: 'hidden-file' });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    open(new Uint8Array(await f.arrayBuffer()));
    file.value = '';
  });

  return h(
    'div',
    { class: 'screen browser-screen' },
    h('div', { class: 'screen-header' }, button('← Back', back, 'btn ghost'), h('h1', null, 'Replays'), h('span', { class: 'spacer' }), button('Open replay file…', () => file.click(), 'btn'), file),
    h(
      'div',
      { class: 'card table-card' },
      h('p', { class: 'muted small' }, 'Replays store only inputs and re-run the deterministic simulation, so a 5-minute match is typically under 100 KB.'),
      h('table', { class: 'room-table' }, h('thead', null, h('tr', null, ...['Match', 'Recorded', 'Length', 'Score', ''].map((t) => h('th', null, t)))), tbody),
    ),
  );
}
