import type { KeyBindings } from '../settings.ts';

/**
 * Tracks pressed keys by `KeyboardEvent.code` (layout independent) and
 * suppresses browser shortcuts (scrolling, find, …) for keys bound to the game.
 */
export class KeyboardInput {
  private down = new Set<string>();
  private bound = new Set<string>();
  enabled = true;
  /** Keys pressed since the last `consumePressed` (edge detection for UI actions). */
  private pressed = new Set<string>();

  constructor() {
    window.addEventListener('keydown', this.onDown, { capture: true });
    window.addEventListener('keyup', this.onUp, { capture: true });
    window.addEventListener('blur', () => this.down.clear());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.down.clear();
    });
  }

  setBoundKeys(bindings: KeyBindings[]): void {
    this.bound.clear();
    for (const b of bindings) for (const list of Object.values(b) as string[][]) for (const k of list) this.bound.add(k);
  }

  private isTyping(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  private onDown = (e: KeyboardEvent) => {
    if (this.isTyping(e)) return;
    if (this.enabled && this.bound.has(e.code) && !e.ctrlKey && !e.metaKey && !e.altKey) e.preventDefault();
    if (!e.repeat) this.pressed.add(e.code);
    this.down.add(e.code);
  };

  private onUp = (e: KeyboardEvent) => {
    this.down.delete(e.code);
  };

  isDown(code: string): boolean {
    return this.enabled && this.down.has(code);
  }

  any(codes: readonly string[], exclude?: Set<string>): boolean {
    for (const c of codes) if (!exclude?.has(c) && this.isDown(c)) return true;
    return false;
  }

  /** Returns true once per physical press of `code`. */
  consumePressed(code: string): boolean {
    const had = this.pressed.has(code);
    this.pressed.delete(code);
    return had;
  }

  clearPressed(): void {
    this.pressed.clear();
  }

  /** Reads a direction + kick from a binding set. */
  read(b: KeyBindings, exclude?: Set<string>): { x: number; y: number; kick: boolean } {
    const x = (this.any(b.right, exclude) ? 1 : 0) - (this.any(b.left, exclude) ? 1 : 0);
    const y = (this.any(b.down, exclude) ? 1 : 0) - (this.any(b.up, exclude) ? 1 : 0);
    return { x, y, kick: this.any(b.kick, exclude) };
  }
}
