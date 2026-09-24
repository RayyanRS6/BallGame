import { loadJson, saveJson } from './storage.ts';

export type CameraMode = 'full' | 'dynamic' | 'player';
export type Quality = 'low' | 'medium' | 'high';

export interface KeyBindings {
  up: string[];
  down: string[];
  left: string[];
  right: string[];
  kick: string[];
}

export interface Settings {
  profile: { name: string; avatar: string };
  gameplay: { cameraMode: CameraMode; showNames: boolean; physicsPreset: string };
  graphics: { quality: Quality; particles: boolean; shadows: boolean; screenShake: boolean; ballTrail: boolean; fpsCap: number; showFps: boolean };
  audio: { master: number; effects: number; music: number; muted: boolean };
  network: {
    servers: string[];
    preferredServer: string;
    showNetStats: boolean;
    interpolationMs: number; // 0 = auto
    remoteMode: 'interpolate' | 'predict';
    ballMode: 'predict' | 'interpolate';
    simEnabled: boolean;
    simLatency: number;
    simJitter: number;
    simLoss: number;
    simDuplicate: number;
    simReorder: boolean;
  };
  controls: {
    solo: KeyBindings;
    p2: KeyBindings;
    gamepadKickButtons: number[];
    gamepadDeadzone: number;
    touchLayout: 'joystick' | 'dpad';
    touchSize: number;
    touchOpacity: number;
    touchLeftHanded: boolean;
    touchForce: 'auto' | 'on' | 'off';
  };
  accessibility: { colorblind: boolean; uiScale: number; reducedMotion: boolean; highContrast: boolean; teamLabels: boolean };
  debug: { overlay: boolean; showBodies: boolean; showVelocity: boolean; showContacts: boolean; showInterpolation: boolean; showPredictionError: boolean };
}

export const DEFAULT_SOLO_BINDINGS: KeyBindings = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  kick: ['Space', 'KeyX'],
};

export const DEFAULT_P2_BINDINGS: KeyBindings = {
  up: ['ArrowUp'],
  down: ['ArrowDown'],
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  kick: ['Enter', 'Numpad0', 'ShiftRight'],
};

function defaults(): Settings {
  return {
    profile: { name: `Player${Math.floor(100 + Math.random() * 900)}`, avatar: '' },
    gameplay: { cameraMode: 'full', showNames: true, physicsPreset: 'classic' },
    graphics: { quality: 'high', particles: true, shadows: true, screenShake: true, ballTrail: true, fpsCap: 0, showFps: false },
    audio: { master: 0.8, effects: 0.9, music: 0.35, muted: false },
    network: {
      servers: [],
      preferredServer: 'auto',
      showNetStats: true,
      interpolationMs: 0,
      remoteMode: 'interpolate',
      ballMode: 'predict',
      simEnabled: false,
      simLatency: 100,
      simJitter: 10,
      simLoss: 0,
      simDuplicate: 0,
      simReorder: false,
    },
    controls: {
      solo: structuredClone(DEFAULT_SOLO_BINDINGS),
      p2: structuredClone(DEFAULT_P2_BINDINGS),
      gamepadKickButtons: [0, 2],
      gamepadDeadzone: 0.18,
      touchLayout: 'joystick',
      touchSize: 1,
      touchOpacity: 0.55,
      touchLeftHanded: false,
      touchForce: 'auto',
    },
    accessibility: { colorblind: false, uiScale: 1, reducedMotion: false, highContrast: false, teamLabels: false },
    debug: { overlay: false, showBodies: true, showVelocity: true, showContacts: true, showInterpolation: false, showPredictionError: true },
  };
}

const KEY = 'momentum.settings.v1';

/** Deep-merges persisted values over defaults, keeping only known keys with matching types. */
function merge<T>(base: T, saved: unknown): T {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    if (Array.isArray(base)) return (Array.isArray(saved) ? saved : base) as T;
    return (typeof saved === typeof base ? saved : base) as T;
  }
  if (typeof saved !== 'object' || saved === null) return base;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(base as Record<string, unknown>)) out[k] = merge(v, (saved as Record<string, unknown>)[k]);
  return out as T;
}

type Listener = (s: Settings) => void;

class SettingsStore {
  current: Settings;
  private listeners = new Set<Listener>();

  constructor() {
    this.current = merge(defaults(), loadJson<unknown>(KEY, null));
  }

  get(): Settings {
    return this.current;
  }

  /** Mutate settings through a callback; persists and notifies. */
  update(fn: (s: Settings) => void): void {
    fn(this.current);
    saveJson(KEY, this.current);
    for (const l of this.listeners) l(this.current);
  }

  onChange(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  reset(section?: keyof Settings): void {
    this.update((s) => {
      const d = defaults();
      if (section) (s as unknown as Record<string, unknown>)[section] = d[section];
      else Object.assign(s, d, { profile: s.profile });
    });
  }
}

export const settings = new SettingsStore();
