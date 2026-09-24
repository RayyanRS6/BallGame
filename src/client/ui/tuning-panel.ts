import { PHYSICS_PARAMS, PHYSICS_PRESETS, sanitizePhysicsConfig, type PhysicsConfig } from '../../shared/constants/physics-config.ts';
import { button, checkbox, downloadBlob, h, select, slider } from './dom.ts';
import { toast } from './toast.ts';

/**
 * Live physics tuning: every parameter of PhysicsConfig with its validated
 * range. Changes apply immediately to the local simulation; the result can be
 * exported/imported as JSON.
 */
export class TuningPanel {
  readonly root: HTMLDivElement;
  private cfg: PhysicsConfig;
  private onChange: (cfg: PhysicsConfig) => void;
  private list: HTMLDivElement;

  constructor(initial: PhysicsConfig, onChange: (cfg: PhysicsConfig) => void) {
    this.cfg = { ...initial };
    this.onChange = onChange;
    this.list = h('div', { class: 'tuning-list' });
    const presetSel = select(
      [{ value: '', label: 'Load preset…' }, ...PHYSICS_PRESETS.map((p) => ({ value: p.id, label: p.name }))],
      '',
      (id) => {
        const p = PHYSICS_PRESETS.find((x) => x.id === id);
        if (p) this.set({ ...p.config });
      },
    );
    this.root = h(
      'div',
      { class: 'side-panel tuning-panel' },
      h('div', { class: 'panel-title' }, 'Physics tuning'),
      presetSel,
      this.list,
      h(
        'div',
        { class: 'panel-actions' },
        button('Export JSON', () => this.export(), 'btn small'),
        button('Copy', () => this.copy(), 'btn small'),
        button('Import', () => this.importJson(), 'btn small'),
      ),
    );
    this.render();
  }

  get config(): PhysicsConfig {
    return { ...this.cfg };
  }

  set(cfg: PhysicsConfig): void {
    this.cfg = sanitizePhysicsConfig(cfg);
    this.render();
    this.onChange(this.config);
  }

  private render(): void {
    this.list.replaceChildren();
    let group = '';
    for (const meta of PHYSICS_PARAMS) {
      if (meta.group !== group) {
        group = meta.group;
        this.list.append(h('div', { class: 'tuning-group' }, group));
      }
      const value = this.cfg[meta.key];
      let control: HTMLElement;
      if (meta.boolean) {
        control = checkbox(value as boolean, (v) => this.patch(meta.key, v));
      } else {
        const decimals = meta.step >= 1 ? 0 : Math.min(5, Math.ceil(-Math.log10(meta.step)));
        control = slider(value as number, meta.min, meta.max, meta.step, (v) => this.patch(meta.key, v), (v) => v.toFixed(decimals) + (meta.unit ? ` ${meta.unit}` : ''));
      }
      this.list.append(h('label', { class: 'tuning-row', title: meta.help }, h('span', null, meta.label), control));
    }
  }

  private patch(key: keyof PhysicsConfig, value: number | boolean): void {
    (this.cfg as unknown as Record<string, unknown>)[key] = value;
    this.cfg = sanitizePhysicsConfig(this.cfg);
    this.onChange(this.config);
  }

  private json(): string {
    return JSON.stringify(this.cfg, null, 2);
  }

  private export(): void {
    downloadBlob(this.json(), 'momentum-physics.json', 'application/json');
  }

  private copy(): void {
    navigator.clipboard?.writeText(this.json()).then(
      () => toast('Physics config copied to clipboard', 'success'),
      () => toast('Clipboard unavailable', 'error'),
    );
  }

  private importJson(): void {
    const text = window.prompt('Paste a physics JSON configuration');
    if (!text) return;
    try {
      this.set(sanitizePhysicsConfig(JSON.parse(text)));
      toast('Physics config imported (values clamped to safe ranges)', 'success');
    } catch {
      toast('Invalid JSON', 'error');
    }
  }
}
