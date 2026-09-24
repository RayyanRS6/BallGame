import type { CameraMode } from '../settings.ts';
import type { RenderFrame } from './frame.ts';

/**
 * Maps world units to CSS pixels. Modes:
 *  - full:    the whole arena is always visible (fair for competitive play)
 *  - dynamic: zoomed in, follows the ball with look-ahead
 *  - player:  zoomed in on the local player
 */
export class Camera {
  x = 0;
  y = 0;
  scale = 1;
  viewW = 1;
  viewH = 1;
  mode: CameraMode = 'full';
  shakeX = 0;
  shakeY = 0;
  private shake = 0;
  private initialised = false;

  addShake(amount: number): void {
    this.shake = Math.min(18, this.shake + amount);
  }

  update(frame: RenderFrame, dtMs: number, viewW: number, viewH: number, allowShake: boolean): void {
    this.viewW = viewW;
    this.viewH = viewH;
    const m = frame.map;
    const halfW = m.halfWidth + m.outerMarginX + 20;
    const halfH = m.halfHeight + m.outerMarginY + 20;
    const fit = Math.min(viewW / (2 * halfW), viewH / (2 * halfH));
    let targetScale = fit;
    let tx = 0;
    let ty = 0;
    const ball = frame.ball;
    if (this.mode === 'dynamic') {
      targetScale = Math.max(fit, Math.min(viewW / 1100, viewH / 620));
      tx = ball.x + ball.vx * 0.12;
      ty = ball.y + ball.vy * 0.12;
    } else if (this.mode === 'player') {
      targetScale = Math.max(fit, Math.min(viewW / 900, viewH / 520));
      const me = frame.players.find((p) => p.id === frame.focusId);
      tx = me ? me.x : ball.x;
      ty = me ? me.y : ball.y;
    }
    const k = this.initialised ? 1 - Math.exp(-dtMs / 180) : 1;
    this.scale += (targetScale - this.scale) * (this.mode === 'full' ? 1 : k);
    // Keep the view inside the arena.
    const hw = viewW / (2 * this.scale);
    const hh = viewH / (2 * this.scale);
    tx = hw >= halfW ? 0 : Math.max(-halfW + hw, Math.min(halfW - hw, tx));
    ty = hh >= halfH ? 0 : Math.max(-halfH + hh, Math.min(halfH - hh, ty));
    this.x += (tx - this.x) * k;
    this.y += (ty - this.y) * k;
    this.initialised = true;

    if (allowShake && this.shake > 0.05) {
      this.shakeX = (Math.random() * 2 - 1) * this.shake;
      this.shakeY = (Math.random() * 2 - 1) * this.shake;
      this.shake *= Math.exp(-dtMs / 90);
    } else {
      this.shake = 0;
      this.shakeX = this.shakeY = 0;
    }
  }

  /** Screen-space x of world x (CSS px). */
  sx(x: number): number {
    return (x - this.x) * this.scale + this.viewW / 2 + this.shakeX;
  }

  sy(y: number): number {
    return (y - this.y) * this.scale + this.viewH / 2 + this.shakeY;
  }

  reset(): void {
    this.initialised = false;
  }
}
