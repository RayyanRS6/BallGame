export interface PadState {
  x: number;
  y: number;
  kick: boolean;
  start: boolean;
  connected: boolean;
  id: string;
}

const EMPTY: PadState = { x: 0, y: 0, kick: false, start: false, connected: false, id: '' };

/**
 * Gamepad API polling (Xbox, PlayStation and generic "standard mapping"
 * controllers). Left stick with a radial dead zone + D-pad; kick on the
 * configured face buttons (A/Cross by default).
 */
export class GamepadInput {
  deadzone = 0.18;
  kickButtons: number[] = [0, 2];
  private states: PadState[] = [];

  poll(): void {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    this.states.length = 0;
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      let x = pad.axes[0] ?? 0;
      let y = pad.axes[1] ?? 0;
      const mag = Math.hypot(x, y);
      if (mag < this.deadzone) {
        x = 0;
        y = 0;
      } else {
        // Rescale so the output starts at 0 right outside the dead zone.
        const scaled = Math.min(1, (mag - this.deadzone) / (1 - this.deadzone));
        x = (x / mag) * scaled;
        y = (y / mag) * scaled;
      }
      const b = (i: number) => !!pad.buttons[i]?.pressed;
      if (b(12)) y = -1;
      if (b(13)) y = 1;
      if (b(14)) x = -1;
      if (b(15)) x = 1;
      this.states.push({ x, y, kick: this.kickButtons.some(b), start: b(9), connected: true, id: pad.id });
    }
  }

  get(index: number): PadState {
    return this.states[index] ?? EMPTY;
  }

  get count(): number {
    return this.states.length;
  }
}
