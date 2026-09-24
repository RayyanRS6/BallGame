export interface TouchOptions {
  layout: 'joystick' | 'dpad';
  size: number;
  opacity: number;
  leftHanded: boolean;
}

/**
 * On-screen controls: a floating virtual joystick (or fixed 8-way D-pad) and
 * a kick button. Outputs the same normalised vector as the keyboard, so the
 * simulation cannot tell the devices apart.
 */
export class TouchControls {
  readonly root: HTMLDivElement;
  private stickZone: HTMLDivElement;
  private base: HTMLDivElement;
  private knob: HTMLDivElement;
  private kickBtn: HTMLDivElement;
  private stickPointer: number | null = null;
  private kickPointers = new Set<number>();
  private originX = 0;
  private originY = 0;
  private opts: TouchOptions;
  x = 0;
  y = 0;
  /** True once any touch interaction happened (used to auto-show). */
  used = false;

  constructor(container: HTMLElement, opts: TouchOptions) {
    this.opts = opts;
    this.root = document.createElement('div');
    this.root.className = 'touch-controls';
    this.stickZone = document.createElement('div');
    this.stickZone.className = 'touch-stick-zone';
    this.base = document.createElement('div');
    this.base.className = 'touch-stick-base';
    this.knob = document.createElement('div');
    this.knob.className = 'touch-stick-knob';
    this.base.appendChild(this.knob);
    this.stickZone.appendChild(this.base);
    this.kickBtn = document.createElement('div');
    this.kickBtn.className = 'touch-kick';
    this.kickBtn.textContent = 'KICK';
    this.root.append(this.stickZone, this.kickBtn);
    container.appendChild(this.root);

    this.stickZone.addEventListener('pointerdown', this.onStickDown);
    this.stickZone.addEventListener('pointermove', this.onStickMove);
    this.stickZone.addEventListener('pointerup', this.onStickUp);
    this.stickZone.addEventListener('pointercancel', this.onStickUp);
    this.kickBtn.addEventListener('pointerdown', this.onKickDown);
    this.kickBtn.addEventListener('pointerup', this.onKickUp);
    this.kickBtn.addEventListener('pointercancel', this.onKickUp);
    this.kickBtn.addEventListener('pointerleave', this.onKickUp);
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.applyOptions(opts);
  }

  get kick(): boolean {
    return this.kickPointers.size > 0;
  }

  applyOptions(opts: TouchOptions): void {
    this.opts = opts;
    const px = Math.round(130 * opts.size);
    this.root.style.setProperty('--stick-size', `${px}px`);
    this.root.style.setProperty('--kick-size', `${Math.round(96 * opts.size)}px`);
    this.root.style.opacity = String(opts.opacity);
    this.root.classList.toggle('left-handed', opts.leftHanded);
    this.root.classList.toggle('dpad', opts.layout === 'dpad');
    this.resetStick();
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
    if (!v) {
      this.resetStick();
      this.kickPointers.clear();
    }
  }

  private radius(): number {
    return 65 * this.opts.size;
  }

  private onStickDown = (e: PointerEvent) => {
    if (this.stickPointer !== null) return;
    e.preventDefault();
    this.used = true;
    this.stickPointer = e.pointerId;
    this.stickZone.setPointerCapture(e.pointerId);
    const zone = this.stickZone.getBoundingClientRect();
    if (this.opts.layout === 'joystick') {
      // Floating stick: centre where the thumb lands.
      this.originX = e.clientX;
      this.originY = e.clientY;
      this.base.style.left = `${e.clientX - zone.left}px`;
      this.base.style.top = `${e.clientY - zone.top}px`;
    } else {
      const b = this.base.getBoundingClientRect();
      this.originX = b.left + b.width / 2;
      this.originY = b.top + b.height / 2;
    }
    this.base.classList.add('active');
    this.update(e.clientX, e.clientY);
  };

  private onStickMove = (e: PointerEvent) => {
    if (e.pointerId !== this.stickPointer) return;
    e.preventDefault();
    this.update(e.clientX, e.clientY);
  };

  private onStickUp = (e: PointerEvent) => {
    if (e.pointerId !== this.stickPointer) return;
    this.resetStick();
  };

  private resetStick(): void {
    this.stickPointer = null;
    this.x = 0;
    this.y = 0;
    this.knob.style.transform = 'translate(-50%, -50%)';
    this.base.classList.remove('active');
    this.base.style.left = '';
    this.base.style.top = '';
  }

  private update(cx: number, cy: number): void {
    const r = this.radius();
    let dx = cx - this.originX;
    let dy = cy - this.originY;
    const len = Math.hypot(dx, dy);
    if (len > r) {
      dx = (dx / len) * r;
      dy = (dy / len) * r;
    }
    this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    let x = dx / r;
    let y = dy / r;
    if (this.opts.layout === 'dpad') {
      // 8-way quantisation without trigonometry (tan 67.5° ≈ 2.414).
      const ax = Math.abs(x);
      const ay = Math.abs(y);
      if (Math.max(ax, ay) < 0.25) x = y = 0;
      else if (ax > 2.414 * ay) (x = Math.sign(x)), (y = 0);
      else if (ay > 2.414 * ax) (y = Math.sign(y)), (x = 0);
      else (x = Math.sign(x)), (y = Math.sign(y));
    } else if (Math.hypot(x, y) < 0.12) {
      x = y = 0; // dead zone
    }
    this.x = x;
    this.y = y;
  }

  private onKickDown = (e: PointerEvent) => {
    e.preventDefault();
    this.used = true;
    this.kickPointers.add(e.pointerId);
    this.kickBtn.classList.add('active');
  };

  private onKickUp = (e: PointerEvent) => {
    this.kickPointers.delete(e.pointerId);
    if (this.kickPointers.size === 0) this.kickBtn.classList.remove('active');
  };

  destroy(): void {
    this.root.remove();
  }
}
