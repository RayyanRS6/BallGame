import { PHASE_HALFTIME, PHASE_MATCH_END, TEAM_BLUE, TEAM_NAMES, TEAM_RED, type PlayingTeam } from '../../shared/constants/game.ts';
import type { PhysicsConfig } from '../../shared/constants/physics-config.ts';
import { BotBrain } from '../../shared/simulation/ai.ts';
import { getMap } from '../../shared/simulation/maps.ts';
import { encodeReplay, ReplayRecorder } from '../../shared/simulation/replay.ts';
import { mixSeed } from '../../shared/simulation/rng.ts';
import { GameSimulation, type SimEvent } from '../../shared/simulation/simulation.ts';
import type { BotDifficulty, MatchSettings } from '../../shared/types/index.ts';
import { input } from '../input/input-manager.ts';
import { teamPalette } from '../rendering/colors.ts';
import { PlayerPool, type RenderFrame } from '../rendering/frame.ts';
import { storeReplay } from '../replays.ts';
import { settings } from '../settings.ts';
import { button, h, slider, select } from '../ui/dom.ts';
import { matchSummary } from '../ui/match-summary.ts';
import { openModal, type ModalHandle } from '../ui/modal.ts';
import { toast } from '../ui/toast.ts';
import { TuningPanel } from '../ui/tuning-panel.ts';
import type { GameView } from './game-view.ts';
import { fmt, PrevPositions, RateCounter, type GameSession } from './session.ts';

export interface LocalSlot {
  id: number;
  team: PlayingTeam;
  control: 'p1' | 'p2' | 'bot';
  name: string;
  avatar: string;
  difficulty: BotDifficulty;
}

export interface LocalOptions {
  mode: 'match' | 'training' | 'practice';
  title: string;
  settings: MatchSettings;
  physics: PhysicsConfig;
  slots: LocalSlot[];
  tickRate: number;
  /** Attract mode behind the menus: bots only, silent, no UI. */
  demo?: boolean;
}

export interface LocalCallbacks {
  exit(): void;
  restart(): void;
  watchReplay(bytes: Uint8Array): void;
}

const TRAINING_BOT_ID = 200;
/** Ticks simulated per frame at most (keeps 60 TPS even at ~4 FPS, prevents spirals). */
const MAX_CATCHUP_TICKS = 20;

/**
 * Offline session: local matches vs bots, local multiplayer (shared keyboard
 * / gamepads), tournament series, practice and training. The simulation runs
 * in the browser with the exact same code as the server.
 */
export class LocalSession implements GameSession {
  readonly kind = 'local';
  readonly sim: GameSimulation;
  private opts: LocalOptions;
  private cb: LocalCallbacks;
  private view!: GameView;
  private prev = new PrevPositions();
  private pool = new PlayerPool();
  private bots = new Map<number, BotBrain>();
  private humans: { id: number; slot: 0 | 1 }[] = [];
  private names = new Map<number, { name: string; avatar: string }>();
  private recorder: ReplayRecorder | null = null;
  private replayBytes: Uint8Array | null = null;
  private seed: number;
  private accum = 0;
  private paused = false;
  private tps = new RateCounter();
  private modal: ModalHandle | null = null;
  private tuning: TuningPanel | null = null;
  private tools: HTMLDivElement | null = null;
  private launchSpeed = 700;
  private opponent: 'none' | 'keeper' | 'bot' = 'none';
  private summaryShown = false;

  constructor(opts: LocalOptions, cb: LocalCallbacks) {
    this.opts = opts;
    this.cb = cb;
    this.seed = mixSeed(Date.now(), Math.floor(Math.random() * 1e9));
    this.sim = new GameSimulation({ map: getMap(opts.settings.mapId), physics: opts.physics, settings: opts.settings, tickRate: opts.tickRate, seed: this.seed });
    for (const slot of opts.slots) {
      this.sim.addPlayer(slot.id, slot.team);
      this.names.set(slot.id, { name: slot.name, avatar: slot.avatar });
      if (slot.control === 'bot') this.bots.set(slot.id, new BotBrain(slot.id, slot.difficulty, this.seed + slot.id));
      else this.humans.push({ id: slot.id, slot: slot.control === 'p1' ? 0 : 1 });
    }
    input.localPlayers = Math.max(1, this.humans.length);
    if (opts.mode === 'training') {
      this.sim.startFreePlay();
    } else if (opts.demo) {
      this.sim.startMatch();
    } else {
      this.sim.startMatch();
      this.recorder = new ReplayRecorder(this.sim, this.seed, opts.title);
      for (const slot of opts.slots) this.recorder.describePlayer({ id: slot.id, name: slot.name, avatar: slot.avatar, team: slot.team });
    }
  }

  attach(view: GameView): void {
    this.view = view;
    if (this.opts.demo) {
      view.root.classList.add('demo');
      return;
    }
    if (this.opts.mode !== 'match') this.buildSidePanels();
    if (this.opts.mode === 'training') this.view.hud.banner('TRAINING', 'R reset ball · B ball to me · L launch · T reset players · Esc menu', '#7ce0c3', 4500);
  }

  // ------------------------------------------------------------------ training / practice UI

  private buildSidePanels(): void {
    this.tuning = new TuningPanel(this.sim.physics, (cfg) => this.sim.applyPhysics(cfg));
    this.view.overlay.append(this.tuning.root);
    if (this.opts.mode !== 'training') return;
    this.tools = h(
      'div',
      { class: 'side-panel tools-panel' },
      h('div', { class: 'panel-title' }, 'Training'),
      button('Reset ball  (R)', () => this.sim.resetBall(), 'btn small block'),
      button('Ball to me  (B)', () => this.ballToMe(), 'btn small block'),
      button('Launch at me  (L)', () => this.launch(), 'btn small block'),
      button('Reset players  (T)', () => this.sim.resetPositions(), 'btn small block'),
      h('div', { class: 'field-label' }, 'Launch speed'),
      slider(this.launchSpeed, 200, 1400, 10, (v) => (this.launchSpeed = v), (v) => `${v} u/s`),
      h('div', { class: 'field-label' }, 'Opponent'),
      select(
        [
          { value: 'none', label: 'None' },
          { value: 'keeper', label: 'Goalkeeper bot' },
          { value: 'bot', label: 'Full bot' },
        ],
        this.opponent,
        (v) => this.setOpponent(v),
      ),
      button('Toggle debug overlay  (F3)', () => settings.update((s) => (s.debug.overlay = !s.debug.overlay)), 'btn small block'),
      button('Hide panels  (H)', () => this.togglePanels(), 'btn small block'),
    );
    this.view.overlay.append(this.tools);
  }

  private togglePanels(): void {
    for (const el of [this.tools, this.tuning?.root]) if (el) el.classList.toggle('collapsed');
  }

  private me() {
    const h0 = this.humans[0];
    return h0 ? this.sim.getPlayer(h0.id) : undefined;
  }

  private ballToMe(): void {
    const me = this.me();
    if (!me) return;
    const dir = me.team === TEAM_RED ? 1 : -1;
    this.sim.resetBall(me.body.x + dir * (me.body.radius + this.sim.ball.radius + 8), me.body.y);
  }

  private launch(): void {
    const me = this.me();
    if (!me) return;
    const W = this.sim.map.halfWidth;
    const sx = me.team === TEAM_RED ? W * 0.6 : -W * 0.6;
    const sy = (Math.random() * 2 - 1) * this.sim.map.halfHeight * 0.6;
    const dx = me.body.x - sx;
    const dy = me.body.y - sy;
    const d = Math.hypot(dx, dy) || 1;
    this.sim.resetBall(sx, sy, (dx / d) * this.launchSpeed, (dy / d) * this.launchSpeed);
  }

  private setOpponent(v: 'none' | 'keeper' | 'bot'): void {
    this.opponent = v;
    this.sim.removePlayer(TRAINING_BOT_ID);
    this.bots.delete(TRAINING_BOT_ID);
    if (v === 'none') return;
    const myTeam = this.me()?.team ?? TEAM_RED;
    const team = myTeam === TEAM_RED ? TEAM_BLUE : TEAM_RED;
    this.sim.addPlayer(TRAINING_BOT_ID, team);
    this.names.set(TRAINING_BOT_ID, { name: v === 'keeper' ? 'Keeper' : 'Sparring', avatar: 'AI' });
    const brain = new BotBrain(TRAINING_BOT_ID, 'hard', this.seed);
    if (v === 'keeper') brain.roleOverride = 'keeper';
    this.bots.set(TRAINING_BOT_ID, brain);
  }

  // ------------------------------------------------------------------ loop

  update(dtMs: number, now: number): void {
    const kb = input.keyboard;
    if (this.opts.demo) {
      this.advance(dtMs, now);
      return;
    }
    if (this.opts.mode === 'training' && !this.paused) {
      if (kb.consumePressed('KeyR')) this.sim.resetBall();
      if (kb.consumePressed('KeyB')) this.ballToMe();
      if (kb.consumePressed('KeyL')) this.launch();
      if (kb.consumePressed('KeyT')) this.sim.resetPositions();
      if (kb.consumePressed('KeyH')) this.togglePanels();
    }
    kb.clearPressed();
    if (this.paused) return;
    this.advance(dtMs, now);
  }

  private advance(dtMs: number, now: number): void {
    const tickMs = 1000 / this.sim.tickRate;
    this.accum += dtMs;
    let n = 0;
    while (this.accum >= tickMs && n < MAX_CATCHUP_TICKS) {
      this.accum -= tickMs;
      this.tick(now);
      n++;
    }
    if (n === MAX_CATCHUP_TICKS) this.accum = 0; // never spiral after a long stall
  }

  private tick(now: number): void {
    const sim = this.sim;
    this.prev.capture(sim.world);
    for (const hmn of this.humans) {
      const inp = input.read(hmn.slot);
      sim.setInput(hmn.id, inp.x, inp.y, inp.kick);
    }
    for (const [id, bot] of this.bots) {
      const inp = bot.think(sim);
      sim.setInput(id, inp.x, inp.y, inp.kick);
    }
    this.recorder?.recordInputs(sim);
    sim.world.recordContacts = settings.get().debug.overlay;
    sim.step();
    this.tps.tick(now);
    if (this.opts.demo) {
      if (sim.match.phase === PHASE_MATCH_END && sim.match.phaseTicks <= 0) sim.startMatch();
      return;
    }
    for (const e of sim.events) this.onEvent(e);
  }

  private onEvent(e: SimEvent): void {
    const fx = this.view.effects;
    switch (e.type) {
      case 'kick':
      case 'ballHit':
      case 'playerHit':
        fx.physical(e);
        break;
      case 'goal': {
        fx.goal(e.team, e.x, e.y);
        const scorer = this.names.get(e.scorerId)?.name;
        const assist = this.names.get(e.assistId)?.name;
        const sub = scorer ? (e.ownGoal ? `Own goal by ${scorer}` : `${scorer}${assist ? `  (assist ${assist})` : ''}`) : '';
        this.view.hud.banner('GOAL!', sub, teamPalette(e.team).fill, 2000);
        break;
      }
      case 'countdown':
        fx.countdown(e.value);
        break;
      case 'phase':
        fx.phase(e.phase);
        if (e.phase === PHASE_HALFTIME) this.view.hud.banner('HALF TIME', '', '#ffffff', 2500);
        break;
      case 'overtime':
        this.view.hud.banner('GOLDEN GOAL', 'Next goal wins', '#ffd166', 2500);
        break;
      case 'matchEnd': {
        const w = e.winner === TEAM_RED || e.winner === TEAM_BLUE ? `${TEAM_NAMES[e.winner]} wins` : 'Draw';
        this.view.hud.banner(e.seriesOver ? 'FULL TIME' : `ROUND ${this.sim.match.round}`, w, '#ffffff', 3000);
        if (e.seriesOver) {
          if (this.recorder) {
            const data = this.recorder.finish(this.sim);
            this.replayBytes = encodeReplay(data);
            this.recorder = null;
          }
          setTimeout(() => this.showSummary(), 2200);
        }
        break;
      }
      case 'fault':
        console.warn('simulation fault', e.reason);
        break;
      default:
        break;
    }
  }

  private showSummary(): void {
    if (this.summaryShown || this.sim.match.phase !== PHASE_MATCH_END) return;
    this.summaryShown = true;
    const m = this.sim.match;
    const winner = m.scoreRed > m.scoreBlue ? TEAM_RED : m.scoreBlue > m.scoreRed ? TEAM_BLUE : 0;
    const players = this.opts.slots.map((s) => ({ id: s.id, name: s.name, team: s.team }));
    const content = matchSummary(winner, m.scoreRed, m.scoreBlue, this.sim.getStats(), players);
    this.modal?.close();
    this.modal = openModal(
      this.view.overlay,
      'Match over',
      content,
      [
        { label: 'Rematch', primary: true, onClick: () => this.cb.restart() },
        ...(this.replayBytes ? [{ label: 'Watch replay', onClick: () => this.cb.watchReplay(this.replayBytes!) }, { label: 'Save replay', onClick: () => this.saveReplay() }] : []),
        { label: 'Main menu', onClick: () => this.cb.exit() },
      ],
      { wide: true },
    );
  }

  private saveReplay(): void {
    if (!this.replayBytes) return;
    const m = this.sim.match;
    const ok = storeReplay(this.replayBytes, {
      title: this.opts.title,
      recordedAt: Date.now(),
      durationSec: Math.round(m.timeTicks / this.sim.tickRate),
      scoreRed: m.scoreRed,
      scoreBlue: m.scoreBlue,
    });
    toast(ok ? 'Replay saved to your library' : 'Could not save replay (storage full?)', ok ? 'success' : 'error');
  }

  onMenu(): void {
    if (this.summaryShown || this.opts.demo) return;
    if (this.modal) {
      this.modal.close();
      return;
    }
    this.paused = true;
    const actions = [
      { label: 'Resume', primary: true, onClick: () => this.modal?.close() },
      { label: 'Restart', onClick: () => this.cb.restart() },
      ...(this.tuning ? [{ label: 'Toggle panels', onClick: () => this.togglePanels() }] : []),
      { label: 'Quit to menu', danger: true, onClick: () => this.cb.exit() },
    ];
    this.modal = openModal(this.view.overlay, 'Paused', h('p', { class: 'muted' }, this.opts.title), actions, {
      onClose: () => {
        this.modal = null;
        this.paused = false;
      },
    });
  }

  // ------------------------------------------------------------------ rendering

  fillFrame(frame: RenderFrame): void {
    const sim = this.sim;
    const alpha = Math.min(1, this.accum / (1000 / sim.tickRate));
    this.pool.begin(frame);
    const localIds = new Set(this.humans.map((x) => x.id));
    for (const p of sim.players) {
      const rp = this.pool.next(frame);
      const n = this.names.get(p.id);
      rp.id = p.id;
      rp.team = p.team;
      rp.x = this.prev.lerpX(p.id, p.body.x, alpha);
      rp.y = this.prev.lerpY(p.id, p.body.y, alpha);
      rp.vx = p.body.vx;
      rp.vy = p.body.vy;
      rp.kicking = p.kick;
      rp.name = n?.name ?? '';
      rp.avatar = n?.avatar ?? '';
      rp.isLocal = localIds.has(p.id);
    }
    const b = sim.ball;
    frame.ball.x = this.prev.lerpX(b.id, b.x, alpha);
    frame.ball.y = this.prev.lerpY(b.id, b.y, alpha);
    frame.ball.vx = b.vx;
    frame.ball.vy = b.vy;
    frame.ball.w = b.w;
    frame.map = sim.map;
    frame.physics = sim.physics;
    frame.match = sim.match;
    frame.settings = sim.settings;
    frame.tickRate = sim.tickRate;
    frame.focusId = this.humans[0]?.id ?? 0;
    frame.localTeam = this.me()?.team ?? 0;
    frame.hudSub = this.paused ? 'PAUSED' : this.opts.mode === 'practice' ? 'PRACTICE' : '';
    frame.net = null;
    frame.debug.world = settings.get().debug.overlay ? sim.world : null;
    frame.debug.ghosts.length = 0;
  }

  debugLines(): string[] {
    const sim = this.sim;
    const me = this.me();
    const b = sim.ball;
    const lines = [
      `Physics TPS ${this.tps.rate.toFixed(1)}  (tick ${sim.tick})`,
      `Phase       ${['LOBBY', 'COUNTDOWN', 'PLAYING', 'GOAL_PAUSE', 'HALFTIME', 'MATCH_END', 'RESETTING'][sim.match.phase]}`,
      `Micro-steps ${sim.world.lastMicroSteps}   Collisions ${sim.world.collisionCount}`,
      `Ball pos    ${fmt(b.x)}, ${fmt(b.y)}`,
      `Ball vel    ${fmt(b.vx)}, ${fmt(b.vy)}  |v| ${fmt(Math.hypot(b.vx, b.vy))}`,
      `Ball spin   ${fmt(b.w, 2)} rad/s`,
    ];
    if (me) {
      lines.push(`Player pos  ${fmt(me.body.x)}, ${fmt(me.body.y)}`);
      lines.push(`Player vel  ${fmt(me.body.vx)}, ${fmt(me.body.vy)}  |v| ${fmt(Math.hypot(me.body.vx, me.body.vy))}`);
      lines.push(`Input       ${me.ix}, ${me.iy} ${me.kick ? 'KICK' : ''}  cooldown ${me.cooldown}`);
    }
    return lines;
  }

  destroy(): void {
    const m = this.modal;
    this.modal = null;
    m?.close();
    input.localPlayers = 1;
  }
}
