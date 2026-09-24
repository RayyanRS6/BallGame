import { input } from '../input/input-manager.ts';
import { TouchControls } from '../input/touch.ts';
import { createFrame } from '../rendering/frame.ts';
import { Renderer } from '../rendering/renderer.ts';
import { settings } from '../settings.ts';
import { h } from '../ui/dom.ts';
import { Hud } from '../ui/hud.ts';
import { Effects } from './effects.ts';
import { RateCounter, type GameSession } from './session.ts';

/**
 * Hosts the canvas, HUD, touch controls and session overlays, and runs the
 * render loop. The loop only *renders* at display rate; sessions advance
 * their simulations in fixed ticks from the elapsed time.
 */
export class GameView {
  readonly root: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  readonly renderer: Renderer;
  readonly effects: Effects;
  readonly hud: Hud;
  /** Layer for session UI (room panel, tuning panel, replay controls …). */
  readonly overlay: HTMLDivElement;
  readonly touch: TouchControls;
  readonly fps = new RateCounter();
  private debugEl: HTMLPreElement;
  private session: GameSession | null = null;
  private frame = createFrame();
  private raf = 0;
  private rafPending = false;
  private watchdog = 0;
  private lastLoopAt = 0;
  private lastTime = 0;
  private lastRender = 0;
  private lastDebug = 0;
  private startWasDown = false;
  private unsub: () => void;

  constructor(container: HTMLElement) {
    this.canvas = h('canvas', { class: 'game-canvas', 'aria-label': 'Game field' });
    this.overlay = h('div', { class: 'game-overlay' });
    this.debugEl = h('pre', { class: 'debug-panel' });
    this.root = h('div', { class: 'game-view' }, this.canvas, h('div', { class: 'rotate-hint' }, '↻ Rotate your device for a bigger pitch'));
    container.append(this.root);
    this.renderer = new Renderer(this.canvas);
    this.effects = new Effects(this.renderer);
    this.hud = new Hud(this.root);
    this.root.append(this.debugEl, this.overlay);
    const c = settings.get().controls;
    this.touch = new TouchControls(this.root, { layout: c.touchLayout, size: c.touchSize, opacity: c.touchOpacity, leftHanded: c.touchLeftHanded });
    input.touch = this.touch;
    this.applySettings();
    this.unsub = settings.onChange(() => this.applySettings());
    window.addEventListener('keydown', this.onKey);
  }

  private applySettings(): void {
    const s = settings.get();
    const c = s.controls;
    this.touch.applyOptions({ layout: c.touchLayout, size: c.touchSize, opacity: c.touchOpacity, leftHanded: c.touchLeftHanded });
    this.updateTouchVisibility();
    this.hud.applyColors();
    this.debugEl.style.display = s.debug.overlay ? '' : 'none';
  }

  private updateTouchVisibility(): void {
    const mode = settings.get().controls.touchForce;
    const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
    this.touch.setVisible(mode === 'on' || (mode === 'auto' && (coarse || this.touch.used)));
  }

  private onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
    if (e.code === 'Escape') {
      if (typing) (target as HTMLElement).blur();
      this.session?.onMenu();
      e.preventDefault();
    } else if ((e.code === 'F3' || e.code === 'Backquote') && !typing) {
      settings.update((s) => (s.debug.overlay = !s.debug.overlay));
      e.preventDefault();
    }
  };

  start(session: GameSession): void {
    this.session = session;
    session.attach(this);
    this.renderer.camera.reset();
    this.renderer.particles.clear();
    this.renderer.resetTrail();
    this.lastTime = performance.now();
    this.schedule();
    // Browsers pause requestAnimationFrame in hidden tabs/panes. Keep the
    // simulation (and, online, the input stream) alive at a lower rate.
    clearInterval(this.watchdog);
    this.watchdog = window.setInterval(() => {
      const now = performance.now();
      if (now - this.lastLoopAt > 200) this.loop(now);
    }, 100);
  }

  private schedule(): void {
    if (this.rafPending) return;
    this.rafPending = true;
    this.raf = requestAnimationFrame(this.onFrame);
  }

  private onFrame = (t: number) => {
    this.rafPending = false;
    this.loop(t);
    this.schedule();
  };

  private loop(t: number): void {
    this.lastLoopAt = performance.now();
    const session = this.session;
    if (!session) return;
    const s = settings.get();
    const cap = s.graphics.fpsCap;
    if (cap > 0 && t - this.lastRender < 1000 / cap - 0.75) return;
    this.lastRender = t;

    const dt = Math.min(250, t - this.lastTime);
    this.lastTime = t;
    input.poll();
    const start = input.startPressed();
    if (start && !this.startWasDown) session.onMenu();
    this.startWasDown = start;

    session.update(dt, t);
    const frame = this.frame;
    session.fillFrame(frame, t);
    this.renderer.draw(frame, dt);
    this.fps.tick(t);
    this.hud.update(frame.match, frame.settings, frame.tickRate, frame.hudSub, s.network.showNetStats ? frame.net : null, s.graphics.showFps || s.debug.overlay ? this.fps.rate : null, t, frame.localTeam);

    if (s.debug.overlay && t - this.lastDebug > 200) {
      this.lastDebug = t;
      this.debugEl.textContent = [`FPS         ${this.fps.rate.toFixed(0)}`, ...session.debugLines()].join('\n');
    }
    if (!this.touch.used || settings.get().controls.touchForce !== 'auto') return;
    if (this.touch.root.style.display === 'none') this.updateTouchVisibility();
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.rafPending = false;
    clearInterval(this.watchdog);
    this.session?.destroy();
    this.session = null;
  }

  destroy(): void {
    this.stop();
    this.unsub();
    window.removeEventListener('keydown', this.onKey);
    if (input.touch === this.touch) input.touch = null;
    this.touch.destroy();
    this.root.remove();
  }
}
