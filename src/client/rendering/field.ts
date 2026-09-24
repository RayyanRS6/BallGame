import type { MapDef } from '../../shared/simulation/maps.ts';
import { PITCH, PITCH_HIGH_CONTRAST } from './colors.ts';
import { teamPalette } from './colors.ts';
import { TEAM_BLUE, TEAM_RED } from '../../shared/constants/game.ts';

const MAX_CACHE_PX = 4096;

/**
 * The static pitch is drawn once into an offscreen canvas at the current
 * zoom and re-used every frame (only re-rendered on zoom/theme changes).
 */
export class FieldCache {
  private canvas: HTMLCanvasElement = document.createElement('canvas');
  private key = '';
  x0 = 0;
  y0 = 0;
  worldW = 0;
  worldH = 0;

  get(map: MapDef, pxPerUnit: number, highContrast: boolean, colorKey: string): HTMLCanvasElement {
    const halfW = map.halfWidth + map.outerMarginX + 60;
    const halfH = map.halfHeight + map.outerMarginY + 60;
    const s = Math.min(pxPerUnit, MAX_CACHE_PX / (2 * halfW), MAX_CACHE_PX / (2 * halfH));
    const key = `${map.id}:${map.version}:${s.toFixed(3)}:${highContrast}:${colorKey}`;
    if (key === this.key) return this.canvas;
    this.key = key;
    this.x0 = -halfW;
    this.y0 = -halfH;
    this.worldW = halfW * 2;
    this.worldH = halfH * 2;
    const c = this.canvas;
    c.width = Math.max(1, Math.ceil(this.worldW * s));
    c.height = Math.max(1, Math.ceil(this.worldH * s));
    const ctx = c.getContext('2d')!;
    ctx.setTransform(s, 0, 0, s, halfW * s, halfH * s);
    drawPitch(ctx, map, highContrast, s);
    return c;
  }
}

function drawPitch(ctx: CanvasRenderingContext2D, m: MapDef, hc: boolean, s: number): void {
  const P = hc ? PITCH_HIGH_CONTRAST : PITCH;
  const W = m.halfWidth;
  const H = m.halfHeight;
  const G = m.goalHalfWidth;
  const D = m.goalDepth;
  const OX = W + m.outerMarginX;
  const OY = H + m.outerMarginY;
  const halfW = OX + 60;
  const halfH = OY + 60;

  ctx.fillStyle = P.background;
  ctx.fillRect(-halfW, -halfH, halfW * 2, halfH * 2);
  // Run-off area (players may leave the lines, the ball may not).
  ctx.fillStyle = P.outer;
  roundRect(ctx, -OX, -OY, OX * 2, OY * 2, 24);
  ctx.fill();

  // Mowing stripes.
  const bands = 14;
  const bw = (W * 2) / bands;
  for (let i = 0; i < bands; i++) {
    ctx.fillStyle = i % 2 === 0 ? P.stripeA : P.stripeB;
    ctx.fillRect(-W + i * bw, -H, bw + 0.5, H * 2);
  }
  // Subtle team tint near each goal.
  if (!hc) {
    for (const [team, side] of [[TEAM_RED, -1], [TEAM_BLUE, 1]] as const) {
      const grad = ctx.createLinearGradient(side * W, 0, side * (W - 260), 0);
      grad.addColorStop(0, hexAlpha(teamPalette(team).fill, 0.14));
      grad.addColorStop(1, hexAlpha(teamPalette(team).fill, 0));
      ctx.fillStyle = grad;
      ctx.fillRect(side === -1 ? -W : W - 260, -H, 260, H * 2);
    }
  }

  const lw = hc ? 4 : 3;
  ctx.strokeStyle = P.line;
  ctx.lineWidth = lw;
  ctx.lineJoin = 'round';
  ctx.strokeRect(-W, -H, W * 2, H * 2);
  ctx.beginPath();
  ctx.moveTo(0, -H);
  ctx.lineTo(0, H);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, m.centerRadius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = P.line;
  ctx.beginPath();
  ctx.arc(0, 0, 5, 0, Math.PI * 2);
  ctx.fill();

  // Keeper zones (visual only) and corner arcs.
  for (const side of [-1, 1]) {
    const x = side * W;
    ctx.beginPath();
    ctx.arc(x, 0, G * 1.7, side === -1 ? -Math.PI / 2 : Math.PI / 2, side === -1 ? Math.PI / 2 : (3 * Math.PI) / 2);
    ctx.stroke();
    for (const sy of [-1, 1]) {
      ctx.beginPath();
      const start = side === -1 ? (sy === -1 ? 0 : -Math.PI / 2) : sy === -1 ? Math.PI / 2 : Math.PI;
      ctx.arc(x, sy * H, 22, start, start + Math.PI / 2);
      ctx.stroke();
    }
  }

  // Goals: net mesh + frame.
  for (const side of [-1, 1] as const) {
    const gx = side * W;
    const bx = side * (W + D);
    const left = Math.min(gx, bx);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(left, -G, D, G * 2);
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, -G, D, G * 2);
    ctx.clip();
    ctx.strokeStyle = P.net;
    ctx.lineWidth = Math.max(0.6, 1 / s);
    const step = 10;
    ctx.beginPath();
    for (let d = -G * 2; d < G * 2 + D; d += step) {
      ctx.moveTo(left + d, -G);
      ctx.lineTo(left + d + G * 2, G);
      ctx.moveTo(left + d, G);
      ctx.lineTo(left + d + G * 2, -G);
    }
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = P.line;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(gx, -G);
    ctx.lineTo(bx, -G);
    ctx.lineTo(bx, G);
    ctx.lineTo(gx, G);
    ctx.stroke();
    for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(gx, sy * G, m.postRadius, 0, Math.PI * 2);
      ctx.fillStyle = P.post;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.stroke();
    }
  }
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function hexAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
