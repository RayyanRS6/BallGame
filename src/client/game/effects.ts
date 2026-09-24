import { PHASE_HALFTIME, PHASE_MATCH_END, type PlayingTeam } from '../../shared/constants/game.ts';
import type { SimEvent } from '../../shared/simulation/simulation.ts';
import { audio } from '../audio/audio.ts';
import { teamPalette } from '../rendering/colors.ts';
import type { Renderer } from '../rendering/renderer.ts';

/**
 * Turns simulation events into sound, particles and screen shake. Effects are
 * strictly cosmetic: nothing here writes back into the simulation.
 */
export class Effects {
  private renderer: Renderer;
  private lastKickBy = new Map<number, number>();

  constructor(renderer: Renderer) {
    this.renderer = renderer;
  }

  /** Physical events (kicks, impacts) — safe to take from predicted simulation. */
  physical(e: SimEvent): void {
    const p = this.renderer.particles;
    switch (e.type) {
      case 'kick': {
        this.lastKickBy.set(e.playerId, performance.now());
        audio.kick(e.speed / 900);
        p.burst(e.x, e.y, 10, 260, '#ffffff', { dirX: e.dirX, dirY: e.dirY, spread: 0.7, life: 0.3, size: 2.2 });
        if (e.speed > 900) this.renderer.shake(2.5);
        break;
      }
      case 'ballHit':
        if (e.surface === 'player') audio.bump(e.speed);
        else if (e.surface === 'post') {
          audio.post(e.speed);
          p.burst(e.x, e.y, 12, 200, '#fff6c8', { life: 0.35 });
          this.renderer.shake(Math.min(6, e.speed / 200));
        } else if (e.surface === 'net') audio.net(e.speed);
        else {
          audio.wall(e.speed);
          if (e.speed > 250) p.burst(e.x, e.y, Math.min(14, e.speed / 60), e.speed * 0.25, '#d9f5e6', { life: 0.3, size: 1.8 });
        }
        break;
      case 'playerHit':
        audio.bump(e.speed * 0.6);
        break;
      default:
        break;
    }
  }

  /** A kick observed only via snapshots (remote player) — avoid doubling predicted ones. */
  remoteKick(playerId: number, x: number, y: number): void {
    const last = this.lastKickBy.get(playerId) ?? 0;
    if (performance.now() - last < 250) return;
    this.lastKickBy.set(playerId, performance.now());
    audio.kick(0.7);
    this.renderer.particles.burst(x, y, 8, 220, '#ffffff', { life: 0.25 });
  }

  goal(team: PlayingTeam, x: number, y: number): void {
    audio.goal();
    const pal = teamPalette(team);
    const p = this.renderer.particles;
    p.burst(x, y, 90, 700, pal.fill, { life: 1.2, size: 3.5 });
    p.burst(x, y, 50, 520, pal.light, { life: 1.4, size: 2.5 });
    p.burst(x, y, 30, 400, '#ffffff', { life: 0.9, size: 2 });
    this.renderer.shake(12);
  }

  countdown(n: number): void {
    audio.countdown(n);
    if (n === 0) audio.whistle(false);
  }

  phase(phase: number): void {
    if (phase === PHASE_MATCH_END) audio.whistle(true);
    else if (phase === PHASE_HALFTIME) audio.whistle(true);
  }
}
