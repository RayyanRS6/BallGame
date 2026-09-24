import { PHASE_HALFTIME } from '../../shared/constants/game.ts';
import { ReplayPlayer, type ReplayData } from '../../shared/simulation/replay.ts';
import { input } from '../input/input-manager.ts';
import { teamPalette } from '../rendering/colors.ts';
import { PlayerPool, type RenderFrame } from '../rendering/frame.ts';
import { settings } from '../settings.ts';
import { button, h, setText } from '../ui/dom.ts';
import { formatClock } from '../ui/hud.ts';
import type { GameView } from './game-view.ts';
import { fmt, PrevPositions, type GameSession } from './session.ts';

const SPEEDS = [0.25, 0.5, 1, 2, 4];

/** Plays a deterministic input replay with play/pause, speed, seek and restart. */
export class ReplaySession implements GameSession {
  readonly kind = 'replay';
  private player: ReplayPlayer;
  private data: ReplayData;
  private exit: () => void;
  private view!: GameView;
  private prev = new PrevPositions();
  private pool = new PlayerPool();
  private accum = 0;
  private speed = 1;
  private paused = false;
  private bar!: HTMLDivElement;
  private seek!: HTMLInputElement;
  private timeLabel!: HTMLSpanElement;
  private playBtn!: HTMLButtonElement;
  private speedBtns: HTMLButtonElement[] = [];
  private seeking = false;

  constructor(data: ReplayData, exit: () => void) {
    this.data = data;
    this.exit = exit;
    this.player = new ReplayPlayer(data);
  }

  attach(view: GameView): void {
    this.view = view;
    this.player.buildKeyframes();
    this.player.sim.emitEvents = true;
    const total = this.data.endTick - this.data.startTick;
    this.seek = h('input', { type: 'range', class: 'slider replay-seek', min: '0', max: String(total), step: '1' });
    this.seek.value = '0';
    this.seek.addEventListener('input', () => {
      this.seeking = true;
      this.jump(this.data.startTick + Number(this.seek.value));
    });
    this.seek.addEventListener('change', () => (this.seeking = false));
    this.timeLabel = h('span', { class: 'replay-time' });
    this.playBtn = button('Pause', () => this.togglePause(), 'btn small');
    this.speedBtns = SPEEDS.map((s) => button(`${s}×`, () => this.setSpeed(s), 'btn small ghost'));
    this.bar = h(
      'div',
      { class: 'replay-bar' },
      h('span', { class: 'replay-title' }, this.data.title),
      this.playBtn,
      button('Restart', () => this.jump(this.data.startTick), 'btn small'),
      ...this.speedBtns,
      this.seek,
      this.timeLabel,
      button('Exit', () => this.exit(), 'btn small danger'),
    );
    view.overlay.append(this.bar);
    this.setSpeed(1);
    view.hud.banner('REPLAY', 'Space pause · ←/→ seek · 1–5 speed · R restart', '#7ce0c3', 3000);
  }

  private setSpeed(s: number): void {
    this.speed = s;
    SPEEDS.forEach((v, i) => this.speedBtns[i]!.classList.toggle('active', v === s));
  }

  private togglePause(): void {
    this.paused = !this.paused;
    this.playBtn.textContent = this.paused ? 'Play' : 'Pause';
  }

  private jump(tick: number): void {
    this.player.seek(tick);
    this.prev.clear();
    this.accum = 0;
    this.view.renderer.resetTrail();
  }

  update(dtMs: number): void {
    const kb = input.keyboard;
    if (kb.consumePressed('Space')) this.togglePause();
    if (kb.consumePressed('ArrowRight')) this.jump(this.player.tick + this.data.tickRate * 5);
    if (kb.consumePressed('ArrowLeft')) this.jump(this.player.tick - this.data.tickRate * 5);
    if (kb.consumePressed('KeyR')) this.jump(this.data.startTick);
    SPEEDS.forEach((s, i) => {
      if (kb.consumePressed(`Digit${i + 1}`)) this.setSpeed(s);
    });
    kb.clearPressed();

    const tickMs = 1000 / this.data.tickRate;
    if (!this.paused && !this.player.finished) {
      this.accum += dtMs * this.speed;
      let n = 0;
      while (this.accum >= tickMs && n < 64) {
        this.accum -= tickMs;
        this.prev.capture(this.player.sim.world);
        this.player.step();
        this.handleEvents();
        n++;
      }
      if (n === 64) this.accum = 0;
    }
    if (this.player.finished && !this.paused) this.togglePause();
    const elapsed = (this.player.tick - this.data.startTick) / this.data.tickRate;
    const total = (this.data.endTick - this.data.startTick) / this.data.tickRate;
    setText(this.timeLabel, `${formatClock(elapsed)} / ${formatClock(total)}`);
    if (!this.seeking) this.seek.value = String(this.player.tick - this.data.startTick);
  }

  private handleEvents(): void {
    const fx = this.view.effects;
    const quiet = this.speed > 2;
    for (const e of this.player.sim.events) {
      switch (e.type) {
        case 'kick':
        case 'ballHit':
        case 'playerHit':
          if (!quiet) fx.physical(e);
          break;
        case 'goal': {
          fx.goal(e.team, e.x, e.y);
          const scorer = this.player.playerInfo(e.scorerId)?.name ?? '';
          this.view.hud.banner('GOAL!', e.ownGoal ? `Own goal by ${scorer}` : scorer, teamPalette(e.team).fill, 1800);
          break;
        }
        case 'countdown':
          if (!quiet) fx.countdown(e.value);
          break;
        case 'phase':
          fx.phase(e.phase);
          if (e.phase === PHASE_HALFTIME) this.view.hud.banner('HALF TIME', '', '#fff', 2000);
          break;
        default:
          break;
      }
    }
  }

  fillFrame(frame: RenderFrame): void {
    const sim = this.player.sim;
    const alpha = this.paused ? 1 : Math.min(1, this.accum / (1000 / sim.tickRate));
    this.pool.begin(frame);
    for (const p of sim.players) {
      const rp = this.pool.next(frame);
      const info = this.player.playerInfo(p.id);
      rp.id = p.id;
      rp.team = p.team;
      rp.x = this.prev.lerpX(p.id, p.body.x, alpha);
      rp.y = this.prev.lerpY(p.id, p.body.y, alpha);
      rp.vx = p.body.vx;
      rp.vy = p.body.vy;
      rp.kicking = p.kick;
      rp.name = info?.name ?? `#${p.id}`;
      rp.avatar = info?.avatar ?? '';
      rp.isLocal = false;
    }
    const b = sim.ball;
    frame.ball.x = this.prev.lerpX(0, b.x, alpha);
    frame.ball.y = this.prev.lerpY(0, b.y, alpha);
    frame.ball.vx = b.vx;
    frame.ball.vy = b.vy;
    frame.ball.w = b.w;
    frame.map = sim.map;
    frame.physics = sim.physics;
    frame.match = sim.match;
    frame.settings = sim.settings;
    frame.tickRate = sim.tickRate;
    frame.focusId = 0;
    frame.localTeam = 0;
    frame.hudSub = `REPLAY ${this.speed}×${this.paused ? ' · PAUSED' : ''}`;
    frame.net = null;
    frame.debug.world = settings.get().debug.overlay ? sim.world : null;
    frame.debug.ghosts.length = 0;
  }

  debugLines(): string[] {
    const sim = this.player.sim;
    return [
      `Replay tick ${sim.tick} / ${this.data.endTick}`,
      `Recorded    ${new Date(this.data.recordedAt).toLocaleString()}  v${this.data.gameVersion}`,
      `Inputs      ${this.data.inputs.length} changes, ${this.data.roster.length} roster ops`,
      `Ball        ${fmt(sim.ball.x)}, ${fmt(sim.ball.y)}  |v| ${fmt(Math.hypot(sim.ball.vx, sim.ball.vy))}`,
      `Final hash  ${this.data.finalHash.toString(16)}  current ${sim.hash().toString(16)}`,
    ];
  }

  onMenu(): void {
    this.exit();
  }

  destroy(): void {
    this.bar?.remove();
  }
}
