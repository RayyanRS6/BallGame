import { PHASE_COUNTDOWN, PHASE_LOBBY, TEAM_BLUE, TEAM_RED } from '../../shared/constants/game.ts';
import type { MatchSettings, MatchStateData } from '../../shared/types/index.ts';
import { teamPalette } from '../rendering/colors.ts';
import { h, setText } from './dom.ts';

export interface NetHud {
  ping: number;
  jitter: number;
  loss: number;
  status: 'connected' | 'reconnecting' | 'offline';
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)
    .toString()
    .padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
}

export function matchClock(m: MatchStateData, settings: MatchSettings, tickRate: number): string {
  const secs = m.timeTicks / tickRate;
  if (settings.mode === 'training') return formatClock(secs);
  if (settings.timeLimit > 0) {
    if (m.overtime) return `+${formatClock(secs - settings.timeLimit)}`;
    return formatClock(Math.ceil(settings.timeLimit - secs));
  }
  return formatClock(secs);
}

/**
 * Minimal in-game HUD. DOM nodes are created once; per-frame updates only
 * touch text that actually changed.
 */
export class Hud {
  readonly root: HTMLDivElement;
  private red: HTMLSpanElement;
  private blue: HTMLSpanElement;
  private clock: HTMLDivElement;
  private sub: HTMLDivElement;
  private net: HTMLDivElement;
  private netDot: HTMLSpanElement;
  private netText: HTMLSpanElement;
  private fps: HTMLDivElement;
  private bannerEl: HTMLDivElement;
  private bannerTitle: HTMLDivElement;
  private bannerSub: HTMLDivElement;
  private bannerUntil = 0;
  private lastCountdown = -1;
  private redBadge: HTMLSpanElement;
  private blueBadge: HTMLSpanElement;

  constructor(parent: HTMLElement) {
    this.red = h('span', { class: 'score' }, '0');
    this.blue = h('span', { class: 'score' }, '0');
    this.redBadge = h('span', { class: 'team-badge red', title: 'Red team (solid)' }, h('span', { class: 'team-icon solid' }), 'RED');
    this.blueBadge = h('span', { class: 'team-badge blue', title: 'Blue team (ringed)' }, 'BLUE', h('span', { class: 'team-icon ring' }));
    this.clock = h('div', { class: 'clock' }, '00:00');
    this.sub = h('div', { class: 'clock-sub' });
    this.netDot = h('span', { class: 'net-dot' });
    this.netText = h('span');
    this.net = h('div', { class: 'hud-net' }, this.netDot, this.netText);
    this.fps = h('div', { class: 'hud-fps' });
    this.bannerTitle = h('div', { class: 'banner-title' });
    this.bannerSub = h('div', { class: 'banner-sub' });
    this.bannerEl = h('div', { class: 'banner', 'aria-live': 'assertive' }, this.bannerTitle, this.bannerSub);
    this.root = h(
      'div',
      { class: 'hud' },
      h('div', { class: 'scoreboard' }, h('div', { class: 'score-row' }, this.redBadge, this.red, h('span', { class: 'dash' }, '—'), this.blue, this.blueBadge), this.clock, this.sub),
      this.net,
      this.fps,
      this.bannerEl,
    );
    parent.append(this.root);
    this.applyColors();
  }

  applyColors(): void {
    this.root.style.setProperty('--red', teamPalette(TEAM_RED).fill);
    this.root.style.setProperty('--blue', teamPalette(TEAM_BLUE).fill);
  }

  update(m: MatchStateData, settings: MatchSettings, tickRate: number, extraSub: string, net: NetHud | null, fps: number | null, now: number, localTeam: number): void {
    // Mark the local player's team (text marker, not colour alone).
    this.redBadge.classList.toggle('mine', localTeam === TEAM_RED);
    this.blueBadge.classList.toggle('mine', localTeam === TEAM_BLUE);
    setText(this.red, String(m.scoreRed));
    setText(this.blue, String(m.scoreBlue));
    setText(this.clock, m.phase === PHASE_LOBBY && settings.mode !== 'training' ? 'WARM-UP' : matchClock(m, settings, tickRate));
    const parts: string[] = [];
    if (settings.rounds > 1) parts.push(`Round ${m.round} · ${m.roundWinsRed}–${m.roundWinsBlue}`);
    if (m.overtime) parts.push('GOLDEN GOAL');
    if (extraSub) parts.push(extraSub);
    setText(this.sub, parts.join('  ·  '));

    if (net) {
      this.net.style.display = '';
      const text = net.status === 'reconnecting' ? 'Reconnecting…' : `${Math.round(net.ping)} ms  ±${Math.round(net.jitter)}  ${(net.loss * 100).toFixed(1)}%`;
      setText(this.netText, text);
      const cls = net.status !== 'connected' ? 'bad' : net.ping < 80 && net.loss < 0.02 ? 'good' : net.ping < 160 && net.loss < 0.06 ? 'ok' : 'bad';
      if (this.netDot.className !== `net-dot ${cls}`) this.netDot.className = `net-dot ${cls}`;
    } else this.net.style.display = 'none';

    if (fps !== null) {
      this.fps.style.display = '';
      setText(this.fps, `${Math.round(fps)} FPS`);
    } else this.fps.style.display = 'none';

    // Countdown numbers straight from the (authoritative) match state.
    if (m.phase === PHASE_COUNTDOWN) {
      const n = Math.ceil(m.phaseTicks / tickRate);
      if (n !== this.lastCountdown && n > 0) {
        this.lastCountdown = n;
        this.banner(String(n), '', '#ffffff', 900, now);
      }
    } else if (this.lastCountdown > 0) {
      this.lastCountdown = -1;
      this.banner('GO!', '', '#7ce0c3', 700, now);
    }

    if (this.bannerUntil && now > this.bannerUntil) {
      this.bannerUntil = 0;
      this.bannerEl.classList.remove('show');
    }
  }

  banner(title: string, sub: string, color: string, ms: number, now = performance.now()): void {
    setText(this.bannerTitle, title);
    setText(this.bannerSub, sub);
    this.bannerTitle.style.color = color;
    this.bannerEl.classList.remove('show');
    void this.bannerEl.offsetWidth; // restart CSS animation
    this.bannerEl.classList.add('show');
    this.bannerUntil = now + ms;
  }

  destroy(): void {
    this.root.remove();
  }
}
