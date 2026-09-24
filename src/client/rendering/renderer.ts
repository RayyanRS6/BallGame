import { PHASE_COUNTDOWN, PHASE_PLAYING, PHASE_RESETTING, TEAM_BLUE, TEAM_RED } from '../../shared/constants/game.ts';
import { settings } from '../settings.ts';
import { Camera } from './camera.ts';
import { FieldCache, hexAlpha } from './field.ts';
import type { RenderFrame } from './frame.ts';
import { Particles } from './particles.ts';
import { teamPalette } from './colors.ts';

const TRAIL_LEN = 14;

/**
 * Canvas 2D renderer. Reads a RenderFrame, never the simulation, so it can
 * never influence gameplay. Rendering runs at display rate; the simulation
 * runs at its fixed tick rate.
 */
export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly camera = new Camera();
  readonly particles = new Particles();
  private field = new FieldCache();
  private dpr = 1;
  private cssW = 1;
  private cssH = 1;
  private trailX = new Float32Array(TRAIL_LEN);
  private trailY = new Float32Array(TRAIL_LEN);
  private trailN = 0;
  private trailHead = 0;
  private ballAngle = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not supported by this browser');
    this.ctx = ctx;
  }

  private resize(): void {
    const q = settings.get().graphics.quality;
    const maxDpr = q === 'high' ? 3 : q === 'medium' ? 1.5 : 1;
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (w !== this.cssW || h !== this.cssH || dpr !== this.dpr) {
      this.cssW = w;
      this.cssH = h;
      this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
  }

  resetTrail(): void {
    this.trailN = 0;
  }

  draw(frame: RenderFrame, dtMs: number): void {
    const s = settings.get();
    const reduced = s.accessibility.reducedMotion;
    this.resize();
    const ctx = this.ctx;
    const cam = this.camera;
    cam.mode = s.gameplay.cameraMode;
    cam.update(frame, dtMs, this.cssW, this.cssH, s.graphics.screenShake && !reduced);
    this.particles.density = !s.graphics.particles ? 0 : reduced ? 0.35 : s.graphics.quality === 'low' ? 0.5 : 1;
    this.particles.update(dtMs / 1000);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const hc = s.accessibility.highContrast;
    ctx.fillStyle = hc ? '#000' : '#0c1a14';
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    // Pitch (cached bitmap).
    const map = frame.map;
    const fieldCanvas = this.field.get(map, cam.scale * this.dpr, hc, `${s.accessibility.colorblind}`);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(fieldCanvas, cam.sx(this.field.x0), cam.sy(this.field.y0), this.field.worldW * cam.scale, this.field.worldH * cam.scale);

    this.drawKickoff(frame);
    const shadows = s.graphics.shadows && s.graphics.quality !== 'low';
    if (shadows) this.drawShadows(frame);
    this.drawBallTrail(frame, s.graphics.ballTrail && !reduced);
    this.drawPlayers(frame, s.gameplay.showNames, s.accessibility.teamLabels, hc);
    this.drawBall(frame, dtMs, hc);
    this.particles.draw(ctx, (x) => cam.sx(x), (y) => cam.sy(y), cam.scale);
    if (s.debug.overlay) this.drawDebug(frame);
  }

  private drawKickoff(frame: RenderFrame): void {
    const m = frame.match;
    if (!m.kickoffActive || (m.phase !== PHASE_PLAYING && m.phase !== PHASE_COUNTDOWN && m.phase !== PHASE_RESETTING)) return;
    const ctx = this.ctx;
    const cam = this.camera;
    const R = frame.map.centerRadius;
    const side = m.kickoffTeam === TEAM_RED ? 1 : -1;
    ctx.strokeStyle = hexAlpha(teamPalette(m.kickoffTeam).fill, 0.8);
    ctx.lineWidth = Math.max(2, 3 * cam.scale);
    ctx.setLineDash([8 * cam.scale, 6 * cam.scale]);
    ctx.beginPath();
    ctx.arc(cam.sx(0), cam.sy(0), R * cam.scale, side === 1 ? -Math.PI / 2 : Math.PI / 2, side === 1 ? Math.PI / 2 : (3 * Math.PI) / 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawShadows(frame: RenderFrame): void {
    const ctx = this.ctx;
    const cam = this.camera;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
    const off = 3.5 * cam.scale;
    ctx.beginPath();
    const pr = frame.physics.playerRadius * cam.scale;
    for (const p of frame.players) {
      ctx.moveTo(cam.sx(p.x) + off + pr, cam.sy(p.y) + off);
      ctx.arc(cam.sx(p.x) + off, cam.sy(p.y) + off, pr, 0, Math.PI * 2);
    }
    const br = frame.physics.ballRadius * cam.scale;
    ctx.moveTo(cam.sx(frame.ball.x) + off + br, cam.sy(frame.ball.y) + off);
    ctx.arc(cam.sx(frame.ball.x) + off, cam.sy(frame.ball.y) + off, br, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawPlayers(frame: RenderFrame, showNames: boolean, teamLabels: boolean, hc: boolean): void {
    const ctx = this.ctx;
    const cam = this.camera;
    const r = frame.physics.playerRadius * cam.scale;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of frame.players) {
      const x = cam.sx(p.x);
      const y = cam.sy(p.y);
      const pal = teamPalette(p.team);
      if (p.isLocal) {
        ctx.beginPath();
        ctx.arc(x, y, r + 6 * cam.scale, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 2.5 * cam.scale;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = pal.fill;
      ctx.fill();
      // Team icon beyond colour: blue players carry an inner ring.
      if (p.team === TEAM_BLUE) {
        ctx.beginPath();
        ctx.arc(x, y, r * 0.66, 0, Math.PI * 2);
        ctx.strokeStyle = hexAlpha(pal.light.startsWith('#') ? pal.light : '#ffffff', 0.75);
        ctx.lineWidth = Math.max(1.5, 2.5 * cam.scale);
        ctx.stroke();
      }
      // Outline: bright while the kick button is held.
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1.5, (p.kicking ? 3.5 : hc ? 3.5 : 2.5) * cam.scale);
      ctx.strokeStyle = p.kicking ? '#ffffff' : hc ? '#ffffff' : 'rgba(8, 12, 20, 0.9)';
      ctx.stroke();

      const label = p.avatar || p.name.slice(0, 1).toUpperCase();
      if (label) {
        ctx.font = `700 ${Math.max(8, r * 0.95)}px system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillText(label, x + cam.scale, y + cam.scale * 1.5);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(label, x, y + cam.scale * 0.5);
      }
      if (teamLabels) {
        const bx = x + r * 0.78;
        const by = y - r * 0.78;
        ctx.beginPath();
        ctx.arc(bx, by, Math.max(6, r * 0.38), 0, Math.PI * 2);
        ctx.fillStyle = '#0b1020';
        ctx.fill();
        ctx.font = `800 ${Math.max(7, r * 0.45)}px system-ui, sans-serif`;
        ctx.fillStyle = pal.light;
        ctx.fillText(p.team === TEAM_RED ? 'R' : 'B', bx, by + 0.5);
      }
      if (showNames && p.name) {
        ctx.font = `600 ${Math.max(9, 11 * Math.min(1.4, cam.scale))}px system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillText(p.name, x + 1, y + r + 12 * Math.min(1.4, cam.scale) + 1);
        ctx.fillStyle = p.isLocal ? '#ffffff' : 'rgba(235, 240, 255, 0.85)';
        ctx.fillText(p.name, x, y + r + 12 * Math.min(1.4, cam.scale));
      }
    }
  }

  private drawBallTrail(frame: RenderFrame, enabled: boolean): void {
    const b = frame.ball;
    const speed = Math.hypot(b.vx, b.vy);
    this.trailX[this.trailHead] = b.x;
    this.trailY[this.trailHead] = b.y;
    this.trailHead = (this.trailHead + 1) % TRAIL_LEN;
    this.trailN = Math.min(TRAIL_LEN, this.trailN + 1);
    if (!enabled || speed < 420) return;
    const ctx = this.ctx;
    const cam = this.camera;
    const intensity = Math.min(1, (speed - 420) / 700);
    const r = frame.physics.ballRadius * cam.scale;
    for (let k = 1; k < this.trailN; k++) {
      const idx = (this.trailHead - 1 - k + TRAIL_LEN * 2) % TRAIL_LEN;
      const t = 1 - k / this.trailN;
      ctx.globalAlpha = 0.35 * t * intensity;
      ctx.fillStyle = '#e8f4ff';
      ctx.beginPath();
      ctx.arc(cam.sx(this.trailX[idx]!), cam.sy(this.trailY[idx]!), r * (0.4 + 0.6 * t), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private drawBall(frame: RenderFrame, dtMs: number, hc: boolean): void {
    const ctx = this.ctx;
    const cam = this.camera;
    const b = frame.ball;
    const r = frame.physics.ballRadius * cam.scale;
    const x = cam.sx(b.x);
    const y = cam.sy(b.y);
    this.ballAngle += b.w * (dtMs / 1000);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#f6f8fc';
    ctx.fill();
    // Rotating panel marks make spin visible.
    ctx.fillStyle = '#1b2233';
    for (let k = 0; k < 3; k++) {
      const a = this.ballAngle + (k * Math.PI * 2) / 3;
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * r * 0.52, y + Math.sin(a) * r * 0.52, r * 0.22, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1.5, (hc ? 3 : 2) * cam.scale);
    ctx.strokeStyle = hc ? '#000' : '#0b1020';
    ctx.stroke();
  }

  private drawDebug(frame: RenderFrame): void {
    const d = settings.get().debug;
    const ctx = this.ctx;
    const cam = this.camera;
    const world = frame.debug.world;
    ctx.lineWidth = 1;
    if (d.showBodies && world) {
      ctx.strokeStyle = 'rgba(255, 230, 0, 0.9)';
      ctx.beginPath();
      for (const s of world.segments) {
        if (!s.enabled) continue;
        ctx.moveTo(cam.sx(s.ax), cam.sy(s.ay));
        ctx.lineTo(cam.sx(s.bx), cam.sy(s.by));
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 120, 0, 0.9)';
      for (const c of world.circles) {
        ctx.beginPath();
        ctx.arc(cam.sx(c.x), cam.sy(c.y), c.radius * cam.scale, 0, Math.PI * 2);
        ctx.stroke();
      }
      // Outer planes.
      ctx.strokeStyle = 'rgba(255, 0, 200, 0.7)';
      const m = frame.map;
      const ox = m.halfWidth + m.outerMarginX;
      const oy = m.halfHeight + m.outerMarginY;
      ctx.strokeRect(cam.sx(-ox), cam.sy(-oy), 2 * ox * cam.scale, 2 * oy * cam.scale);
      // Goal sensors: the ball scores once fully past the line within the mouth.
      ctx.fillStyle = 'rgba(0, 255, 160, 0.18)';
      for (const side of [-1, 1]) {
        const x0 = side === 1 ? m.halfWidth : -(m.halfWidth + m.goalDepth);
        ctx.fillRect(cam.sx(x0), cam.sy(-m.goalHalfWidth), m.goalDepth * cam.scale, 2 * m.goalHalfWidth * cam.scale);
      }
      ctx.strokeStyle = 'rgba(0, 255, 255, 0.9)';
      ctx.beginPath();
      for (const b of world.bodies) {
        ctx.moveTo(cam.sx(b.x) + b.radius * cam.scale, cam.sy(b.y));
        ctx.arc(cam.sx(b.x), cam.sy(b.y), b.radius * cam.scale, 0, Math.PI * 2);
      }
      ctx.stroke();
    }
    if (d.showVelocity) {
      ctx.strokeStyle = 'rgba(120, 255, 120, 0.95)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const k = 0.2;
      for (const p of frame.players) {
        ctx.moveTo(cam.sx(p.x), cam.sy(p.y));
        ctx.lineTo(cam.sx(p.x + p.vx * k), cam.sy(p.y + p.vy * k));
      }
      ctx.moveTo(cam.sx(frame.ball.x), cam.sy(frame.ball.y));
      ctx.lineTo(cam.sx(frame.ball.x + frame.ball.vx * k), cam.sy(frame.ball.y + frame.ball.vy * k));
      ctx.stroke();
    }
    if (d.showContacts && world) {
      ctx.fillStyle = '#ff3355';
      ctx.strokeStyle = '#ff3355';
      ctx.lineWidth = 1.5;
      const c = world.debugContacts;
      for (let i = 0; i < world.debugContactCount; i++) {
        const x = cam.sx(c[i * 4]!);
        const y = cam.sy(c[i * 4 + 1]!);
        ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + c[i * 4 + 2]! * 16, y + c[i * 4 + 3]! * 16);
        ctx.stroke();
      }
    }
    for (const g of frame.debug.ghosts) {
      if (g.kind === 'server' && !d.showPredictionError) continue;
      if (g.kind === 'interp' && !d.showInterpolation) continue;
      ctx.strokeStyle = g.kind === 'server' ? 'rgba(255, 60, 60, 0.95)' : 'rgba(160, 120, 255, 0.95)';
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(cam.sx(g.x), cam.sy(g.y), g.r * cam.scale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /** Visual effect helpers used by the effects system. */
  shake(amount: number): void {
    this.camera.addShake(amount);
  }
}
