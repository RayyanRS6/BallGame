import { AXIS_MAX } from '../../shared/constants/game.ts';
import type { InputState } from '../../shared/types/index.ts';
import { settings, type KeyBindings } from '../settings.ts';
import { GamepadInput } from './gamepad.ts';
import { KeyboardInput } from './keyboard.ts';
import type { TouchControls } from './touch.ts';

function quantize(v: number): number {
  return Math.round(Math.max(-1, Math.min(1, v)) * AXIS_MAX);
}

/**
 * Merges every input device into the single InputState used by the
 * simulation. Slot 0 = main player (keyboard + first gamepad + touch);
 * slot 1 = second local player (P2 keys + second gamepad).
 */
export class InputManager {
  readonly keyboard = new KeyboardInput();
  readonly gamepads = new GamepadInput();
  touch: TouchControls | null = null;
  /** Number of local human players (1 or 2) — with 2, P1 ignores P2's keys. */
  localPlayers = 1;
  private p2Keys = new Set<string>();

  constructor() {
    this.refresh();
    settings.onChange(() => this.refresh());
  }

  refresh(): void {
    const c = settings.get().controls;
    this.keyboard.setBoundKeys([c.solo, c.p2]);
    this.gamepads.deadzone = c.gamepadDeadzone;
    this.gamepads.kickButtons = c.gamepadKickButtons;
    this.p2Keys = new Set(Object.values(c.p2 as KeyBindings).flat());
  }

  /** Poll devices that have no events (gamepads). Call once per frame/tick. */
  poll(): void {
    this.gamepads.poll();
  }

  read(slot: 0 | 1): InputState {
    const c = settings.get().controls;
    let x = 0;
    let y = 0;
    let kick = false;
    if (slot === 0) {
      const k = this.keyboard.read(c.solo, this.localPlayers > 1 ? this.p2Keys : undefined);
      x += k.x;
      y += k.y;
      kick ||= k.kick;
      const pad = this.gamepads.get(0);
      x += pad.x;
      y += pad.y;
      kick ||= pad.kick;
      if (this.touch) {
        x += this.touch.x;
        y += this.touch.y;
        kick ||= this.touch.kick;
      }
    } else {
      const k = this.keyboard.read(c.p2);
      x += k.x;
      y += k.y;
      kick ||= k.kick;
      const pad = this.gamepads.get(1);
      x += pad.x;
      y += pad.y;
      kick ||= pad.kick;
    }
    // Clamp the merged vector to the unit circle; keyboard diagonals stay (±1, ±1)
    // and are normalised by the simulation.
    const len = Math.hypot(x, y);
    if (len > 1 && (Math.abs(x) > 1 || Math.abs(y) > 1)) {
      x /= Math.max(Math.abs(x), 1);
      y /= Math.max(Math.abs(y), 1);
    }
    return { x: quantize(x), y: quantize(y), kick };
  }

  /** Start button on any pad (pause menu). */
  startPressed(): boolean {
    return this.gamepads.get(0).start || this.gamepads.get(1).start;
  }
}

export const input = new InputManager();
