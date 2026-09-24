import { PHYSICS_PRESETS } from '../../../shared/constants/physics-config.ts';
import { knownServers, normalizeServerUrl } from '../../network/servers.ts';
import { input } from '../../input/input-manager.ts';
import { settings, type KeyBindings, type Settings } from '../../settings.ts';
import { button, checkbox, field, h, select, slider, textInput } from '../dom.ts';
import { toast } from '../toast.ts';

type Tab = 'gameplay' | 'graphics' | 'audio' | 'controls' | 'network' | 'accessibility' | 'debug';
const TABS: { id: Tab; label: string }[] = [
  { id: 'gameplay', label: 'Gameplay' },
  { id: 'graphics', label: 'Graphics' },
  { id: 'audio', label: 'Audio' },
  { id: 'controls', label: 'Controls' },
  { id: 'network', label: 'Network' },
  { id: 'accessibility', label: 'Accessibility' },
  { id: 'debug', label: 'Debug' },
];

const upd = (fn: (s: Settings) => void) => settings.update(fn);
const pct = (v: number) => `${Math.round(v * 100)}%`;

export function keyLabel(code: string): string {
  const map: Record<string, string> = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Space: 'Space',
    Enter: 'Enter',
    ShiftLeft: 'L-Shift',
    ShiftRight: 'R-Shift',
    ControlLeft: 'L-Ctrl',
    ControlRight: 'R-Ctrl',
  };
  if (map[code]) return map[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}

function bindingsEditor(which: 'solo' | 'p2', title: string): HTMLElement {
  const wrap = h('div', { class: 'bindings' }, h('div', { class: 'card-title' }, title));
  const actions: (keyof KeyBindings)[] = ['up', 'down', 'left', 'right', 'kick'];
  const render = () => {
    wrap.replaceChildren(h('div', { class: 'card-title' }, title));
    const b = settings.get().controls[which];
    for (const a of actions) {
      const keys = h('span', { class: 'keys' }, ...b[a].map((k) => h('kbd', null, keyLabel(k))));
      const listen = (append: boolean) => {
        keys.replaceChildren(h('span', { class: 'muted' }, 'Press a key… (Esc cancels)'));
        const onKey = (e: KeyboardEvent) => {
          e.preventDefault();
          e.stopPropagation();
          window.removeEventListener('keydown', onKey, true);
          if (e.code !== 'Escape') {
            upd((s) => {
              const list = s.controls[which][a];
              if (append) {
                if (!list.includes(e.code)) list.push(e.code);
              } else s.controls[which][a] = [e.code, ...list.slice(1).filter((k) => k !== e.code)];
            });
          }
          render();
        };
        window.addEventListener('keydown', onKey, true);
      };
      wrap.append(
        h('div', { class: 'binding-row' }, h('span', { class: 'binding-action' }, a.toUpperCase()), keys, button('Rebind', () => listen(false), 'btn tiny'), button('+ Add', () => listen(true), 'btn tiny ghost')),
      );
    }
  };
  render();
  return wrap;
}

function tabContent(tab: Tab): HTMLElement {
  const s = settings.get();
  switch (tab) {
    case 'gameplay':
      return h(
        'div',
        { class: 'form-grid' },
        field('Camera', select([{ value: 'full', label: 'Full arena (competitive)' }, { value: 'dynamic', label: 'Dynamic (follows the ball)' }, { value: 'player', label: 'Player-focused' }] as const, s.gameplay.cameraMode, (v) => upd((x) => (x.gameplay.cameraMode = v)))),
        field('Physics preset (local modes)', select(PHYSICS_PRESETS.map((p) => ({ value: p.id, label: p.name })), s.gameplay.physicsPreset, (v) => upd((x) => (x.gameplay.physicsPreset = v)))),
        h('label', { class: 'check-row' }, checkbox(s.gameplay.showNames, (v) => upd((x) => (x.gameplay.showNames = v))), ' Show player names'),
      );
    case 'graphics':
      return h(
        'div',
        { class: 'form-grid' },
        field('Quality', select([{ value: 'high', label: 'High (full resolution)' }, { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low (fastest)' }] as const, s.graphics.quality, (v) => upd((x) => (x.graphics.quality = v)))),
        field('Frame rate cap', select([0, 30, 60, 120, 144, 240].map((n) => ({ value: n, label: n ? `${n} FPS` : 'Unlimited (display rate)' })), s.graphics.fpsCap, (v) => upd((x) => (x.graphics.fpsCap = v))), 'Physics is identical at every frame rate'),
        h('label', { class: 'check-row' }, checkbox(s.graphics.particles, (v) => upd((x) => (x.graphics.particles = v))), ' Particle effects'),
        h('label', { class: 'check-row' }, checkbox(s.graphics.shadows, (v) => upd((x) => (x.graphics.shadows = v))), ' Shadows'),
        h('label', { class: 'check-row' }, checkbox(s.graphics.screenShake, (v) => upd((x) => (x.graphics.screenShake = v))), ' Screen shake'),
        h('label', { class: 'check-row' }, checkbox(s.graphics.ballTrail, (v) => upd((x) => (x.graphics.ballTrail = v))), ' Ball motion trail'),
        h('label', { class: 'check-row' }, checkbox(s.graphics.showFps, (v) => upd((x) => (x.graphics.showFps = v))), ' Show FPS'),
      );
    case 'audio':
      return h(
        'div',
        { class: 'form-grid' },
        field('Master volume', slider(s.audio.master, 0, 1, 0.01, (v) => upd((x) => (x.audio.master = v)), pct)),
        field('Effects volume', slider(s.audio.effects, 0, 1, 0.01, (v) => upd((x) => (x.audio.effects = v)), pct)),
        field('Music volume', slider(s.audio.music, 0, 1, 0.01, (v) => upd((x) => (x.audio.music = v)), pct)),
        h('label', { class: 'check-row' }, checkbox(s.audio.muted, (v) => upd((x) => (x.audio.muted = v))), ' Mute all sound'),
      );
    case 'controls': {
      const padInfo = h('div', { class: 'muted small' });
      const refreshPads = () => {
        input.poll();
        const n = input.gamepads.count;
        padInfo.textContent = n ? `${n} gamepad(s): ${Array.from({ length: n }, (_, i) => input.gamepads.get(i).id).join(' | ')}` : 'No gamepad detected — press a button on your controller.';
      };
      refreshPads();
      const buttons = Array.from({ length: 16 }, (_, i) => i);
      const names = ['A / Cross', 'B / Circle', 'X / Square', 'Y / Triangle', 'LB / L1', 'RB / R1', 'LT / L2', 'RT / R2', 'Back', 'Start', 'L-Stick', 'R-Stick', 'D-Up', 'D-Down', 'D-Left', 'D-Right'];
      return h(
        'div',
        null,
        h('div', { class: 'two-col' }, bindingsEditor('solo', 'Player 1 keyboard'), bindingsEditor('p2', 'Player 2 keyboard (local 2P)')),
        h('div', { class: 'card-title' }, 'Gamepad'),
        padInfo,
        button('Detect gamepads', refreshPads, 'btn tiny'),
        h(
          'div',
          { class: 'form-grid' },
          field('Stick dead zone', slider(s.controls.gamepadDeadzone, 0, 0.5, 0.01, (v) => upd((x) => (x.controls.gamepadDeadzone = v)), pct)),
          field(
            'Kick buttons',
            h(
              'div',
              { class: 'pad-buttons' },
              ...buttons.map((b) =>
                h(
                  'label',
                  { class: 'pad-btn' },
                  checkbox(s.controls.gamepadKickButtons.includes(b), (v) =>
                    upd((x) => {
                      const set = new Set(x.controls.gamepadKickButtons);
                      if (v) set.add(b);
                      else set.delete(b);
                      x.controls.gamepadKickButtons = [...set].sort((p, q) => p - q);
                    }),
                  ),
                  ` ${names[b]}`,
                ),
              ),
            ),
          ),
        ),
        h('div', { class: 'card-title' }, 'Touch'),
        h(
          'div',
          { class: 'form-grid' },
          field('Show touch controls', select([{ value: 'auto', label: 'Automatic' }, { value: 'on', label: 'Always' }, { value: 'off', label: 'Never' }] as const, s.controls.touchForce, (v) => upd((x) => (x.controls.touchForce = v)))),
          field('Layout', select([{ value: 'joystick', label: 'Floating joystick' }, { value: 'dpad', label: '8-way directional pad' }] as const, s.controls.touchLayout, (v) => upd((x) => (x.controls.touchLayout = v)))),
          field('Size', slider(s.controls.touchSize, 0.6, 1.6, 0.05, (v) => upd((x) => (x.controls.touchSize = v)), pct)),
          field('Opacity', slider(s.controls.touchOpacity, 0.2, 1, 0.05, (v) => upd((x) => (x.controls.touchOpacity = v)), pct)),
          h('label', { class: 'check-row' }, checkbox(s.controls.touchLeftHanded, (v) => upd((x) => (x.controls.touchLeftHanded = v))), ' Left-handed (swap sides)'),
        ),
        button('Reset controls to defaults', () => {
          settings.reset('controls');
          toast('Controls reset');
        }, 'btn small danger ghost'),
      );
    }
    case 'network': {
      const list = h('div', { class: 'server-edit' });
      const renderList = () => {
        list.replaceChildren(
          ...settings.get().network.servers.map((u) =>
            h('div', { class: 'row' }, h('code', null, u), h('span', { class: 'spacer' }), button('Remove', () => {
              upd((x) => (x.network.servers = x.network.servers.filter((v) => v !== u)));
              renderList();
            }, 'btn tiny danger ghost')),
          ),
        );
      };
      renderList();
      const add = textInput('', { placeholder: 'sg.example.com or https://eu.example.com' });
      return h(
        'div',
        { class: 'form-grid' },
        field('Preferred server', select([{ value: 'auto', label: 'Automatic (lowest ping)' }, ...knownServers().map((u) => ({ value: u, label: u }))], s.network.preferredServer, (v) => upd((x) => (x.network.preferredServer = v)))),
        field(
          'Extra servers',
          h('div', null, list, h('div', { class: 'row' }, add, button('Add', () => {
            const u = normalizeServerUrl(add.value);
            if (!u) return toast('Invalid server address', 'error');
            upd((x) => {
              if (!x.network.servers.includes(u)) x.network.servers.push(u);
            });
            add.value = '';
            renderList();
          }, 'btn small'))),
          'Regional servers you host yourself (see docs/DEPLOYMENT.md)',
        ),
        field('Interpolation delay', select([0, 33, 50, 75, 100, 150].map((n) => ({ value: n, label: n ? `${n} ms` : 'Automatic (adapts to jitter)' })), s.network.interpolationMs, (v) => upd((x) => (x.network.interpolationMs = v)))),
        field('Other players', select([{ value: 'interpolate', label: 'Interpolate (smooth, slightly delayed)' }, { value: 'predict', label: 'Predict (current, may correct)' }] as const, s.network.remoteMode, (v) => upd((x) => (x.network.remoteMode = v)))),
        field('Ball', select([{ value: 'predict', label: 'Predict (responsive touches)' }, { value: 'interpolate', label: 'Interpolate (never corrects)' }] as const, s.network.ballMode, (v) => upd((x) => (x.network.ballMode = v)))),
        h('label', { class: 'check-row' }, checkbox(s.network.showNetStats, (v) => upd((x) => (x.network.showNetStats = v))), ' Show ping / jitter / packet loss in game'),
        h('div', { class: 'card-title' }, 'Network simulator (testing)'),
        h('label', { class: 'check-row' }, checkbox(s.network.simEnabled, (v) => upd((x) => (x.network.simEnabled = v))), ' Simulate network conditions (adds fake lag — keep OFF for real games)'),
        field('Added round-trip latency', slider(s.network.simLatency, 0, 400, 5, (v) => upd((x) => (x.network.simLatency = v)), (v) => `${v} ms`)),
        field('Jitter', slider(s.network.simJitter, 0, 100, 1, (v) => upd((x) => (x.network.simJitter = v)), (v) => `±${v} ms`)),
        field('Packet loss (inputs/snapshots)', slider(s.network.simLoss, 0, 20, 0.5, (v) => upd((x) => (x.network.simLoss = v)), (v) => `${v}%`)),
        field('Duplication', slider(s.network.simDuplicate, 0, 20, 0.5, (v) => upd((x) => (x.network.simDuplicate = v)), (v) => `${v}%`)),
        h('label', { class: 'check-row' }, checkbox(s.network.simReorder, (v) => upd((x) => (x.network.simReorder = v))), ' Allow reordering'),
      );
    }
    case 'accessibility':
      return h(
        'div',
        { class: 'form-grid' },
        field('UI scale', slider(s.accessibility.uiScale, 0.8, 1.6, 0.05, (v) => upd((x) => (x.accessibility.uiScale = v)), pct)),
        h('label', { class: 'check-row' }, checkbox(s.accessibility.colorblind, (v) => upd((x) => (x.accessibility.colorblind = v))), ' Colour-blind friendly team colours (orange / blue)'),
        h('label', { class: 'check-row' }, checkbox(s.accessibility.teamLabels, (v) => upd((x) => (x.accessibility.teamLabels = v))), ' Team letter badges on players (R / B)'),
        h('label', { class: 'check-row' }, checkbox(s.accessibility.highContrast, (v) => upd((x) => (x.accessibility.highContrast = v))), ' High contrast pitch and outlines'),
        h('label', { class: 'check-row' }, checkbox(s.accessibility.reducedMotion, (v) => upd((x) => (x.accessibility.reducedMotion = v))), ' Reduced motion (no shake/trails, fewer particles)'),
        h('p', { class: 'muted small' }, 'Teams are never identified by colour alone: blue players carry an inner ring, the HUD shows team icons, and optional letter badges are available.'),
      );
    case 'debug':
      return h(
        'div',
        { class: 'form-grid' },
        h('label', { class: 'check-row' }, checkbox(s.debug.overlay, (v) => upd((x) => (x.debug.overlay = v))), ' Physics debug overlay (F3)'),
        h('label', { class: 'check-row' }, checkbox(s.debug.showBodies, (v) => upd((x) => (x.debug.showBodies = v))), ' Collision bodies, walls and goal sensors'),
        h('label', { class: 'check-row' }, checkbox(s.debug.showVelocity, (v) => upd((x) => (x.debug.showVelocity = v))), ' Velocity vectors'),
        h('label', { class: 'check-row' }, checkbox(s.debug.showContacts, (v) => upd((x) => (x.debug.showContacts = v))), ' Contact points and normals'),
        h('label', { class: 'check-row' }, checkbox(s.debug.showInterpolation, (v) => upd((x) => (x.debug.showInterpolation = v))), ' Network interpolation ghosts'),
        h('label', { class: 'check-row' }, checkbox(s.debug.showPredictionError, (v) => upd((x) => (x.debug.showPredictionError = v))), ' Prediction error (authoritative positions)'),
      );
  }
}

export function settingsScreen(back: () => void): HTMLElement {
  let active: Tab = 'gameplay';
  const body = h('div', { class: 'card settings-body' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const render = () => {
    tabs.replaceChildren(...TABS.map((t) => button(t.label, () => {
      active = t.id;
      render();
    }, `tab${t.id === active ? ' active' : ''}`)));
    body.replaceChildren(tabContent(active));
  };
  render();
  return h(
    'div',
    { class: 'screen form-screen' },
    h('div', { class: 'screen-header' }, button('← Back', back, 'btn ghost'), h('h1', null, 'Settings')),
    tabs,
    body,
  );
}
