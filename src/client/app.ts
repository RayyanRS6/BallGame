import { TEAM_BLUE, TEAM_RED } from '../shared/constants/game.ts';
import { getPhysicsPreset } from '../shared/constants/physics-config.ts';
import { normalizeRoomCode, type ClientControl, type RoomSettingsInput, type ServerControl } from '../shared/protocol/control.ts';
import { decodeReplay, type ReplayData } from '../shared/simulation/replay.ts';
import { DEFAULT_MATCH_SETTINGS, trainingSettings } from '../shared/simulation/settings.ts';
import type { RoomListing } from '../shared/types/index.ts';
import { audio } from './audio/audio.ts';
import { GameView } from './game/game-view.ts';
import { LocalSession, type LocalOptions } from './game/local-session.ts';
import { OnlineSession, REJOIN_KEY, type JoinedInfo } from './game/online-session.ts';
import { ReplaySession } from './game/replay-session.ts';
import type { GameSession } from './game/session.ts';
import { NetClient } from './network/net-client.ts';
import { normalizeServerUrl, pickServer, probeAll } from './network/servers.ts';
import { settings } from './settings.ts';
import { sessionGet, sessionSet } from './storage.ts';
import { h, textInput } from './ui/dom.ts';
import { openModal, type ModalHandle } from './ui/modal.ts';
import { menuScreen } from './ui/screens/menu.ts';
import { localSetupScreen } from './ui/screens/local-setup.ts';
import { replaysScreen } from './ui/screens/replays.ts';
import { browserScreen, createRoomScreen, joinRoomScreen } from './ui/screens/rooms.ts';
import { settingsScreen } from './ui/screens/settings-screen.ts';
import { toast } from './ui/toast.ts';

const JOIN_TIMEOUT_MS = 10_000;

/** Top-level navigation between menus and game sessions. */
export class App {
  private stage: HTMLElement;
  private screens: HTMLElement;
  private view: GameView | null = null;
  private inGame = false;
  private busy: ModalHandle | null = null;
  private lastLocal: LocalOptions | null = null;

  constructor(root: HTMLElement) {
    this.stage = h('div', { class: 'stage' });
    this.screens = h('div', { class: 'screens' });
    root.append(this.stage, this.screens);
  }

  start(): void {
    const params = new URLSearchParams(location.search);
    const code = normalizeRoomCode(params.get('room') ?? '');
    const server = normalizeServerUrl(params.get('server') ?? '') ?? location.origin;
    const saved = sessionGet(REJOIN_KEY);
    if (saved) {
      // Page reload during a match: try to restore the session.
      try {
        const r = JSON.parse(saved) as { server: string; code: string; token: string };
        this.showMenu();
        void this.goOnline(r.server, { t: 'rejoin', code: r.code, token: r.token }, 'Restoring your session…');
        return;
      } catch {
        sessionSet(REJOIN_KEY, null);
      }
    }
    if (code) {
      history.replaceState(null, '', location.pathname);
      this.showMenu();
      void this.joinWithPasswordRetry(server, code, '');
      return;
    }
    this.showMenu();
  }

  // ------------------------------------------------------------------ screens

  private setScreen(el: HTMLElement | null): void {
    this.screens.replaceChildren();
    if (el) this.screens.append(el);
    this.screens.classList.toggle('active', !!el);
  }

  private ensureDemo(): void {
    if (this.view) return;
    this.view = new GameView(this.stage);
    const slots: LocalOptions['slots'] = [1, 2, 3, 4].map((id) => ({ id, team: id % 2 ? TEAM_RED : TEAM_BLUE, control: 'bot', name: '', avatar: '', difficulty: 'hard' }));
    this.view.start(
      new LocalSession(
        {
          mode: 'match',
          title: 'demo',
          demo: true,
          settings: { ...DEFAULT_MATCH_SETTINGS, timeLimit: 0, scoreLimit: 0, countdownSeconds: 0, teamSize: 2, returnToLobby: false },
          physics: getPhysicsPreset('classic').config,
          slots,
          tickRate: 60,
        },
        { exit() {}, restart() {}, watchReplay() {} },
      ),
    );
  }

  showMenu(): void {
    this.inGame = false;
    this.ensureDemo();
    audio.startMusic();
    this.setScreen(
      menuScreen({
        play: () => void this.quickPlay(),
        createRoom: () => this.setScreen(createRoomScreen(() => this.showMenu(), (server, input) => void this.createRoom(server, input))),
        joinRoom: () => this.showJoin(''),
        browser: () => this.showBrowser(),
        local: () => this.setScreen(localSetupScreen(() => this.showMenu(), (opts) => this.startLocal(opts))),
        training: () => this.startTraining(),
        replays: () => this.showReplays(),
        settings: () => this.setScreen(settingsScreen(() => this.showMenu())),
      }),
    );
  }

  private showJoin(prefill: string): void {
    this.setScreen(joinRoomScreen(() => this.showMenu(), (server, code, pw) => void this.joinWithPasswordRetry(server, code, pw), prefill));
  }

  private showBrowser(): void {
    this.setScreen(
      browserScreen(
        () => this.showMenu(),
        (server, room: RoomListing) => void this.joinWithPasswordRetry(server, room.code, '', room.hasPassword),
        (server) => this.setScreen(createRoomScreen(() => this.showBrowser(), (_s, input) => void this.createRoom(server, input))),
      ),
    );
  }

  private showReplays(): void {
    this.setScreen(replaysScreen(() => this.showMenu(), (data) => this.watchReplay(data)));
  }

  // ------------------------------------------------------------------ sessions

  private startSession(session: GameSession): void {
    this.view?.destroy();
    this.view = new GameView(this.stage);
    this.inGame = true;
    audio.stopMusic();
    this.setScreen(null);
    this.view.start(session);
  }

  private leaveSession(message?: string): void {
    this.view?.destroy();
    this.view = null;
    if (message && message !== 'left') toast(message, 'info', 5000);
    this.showMenu();
  }

  startLocal(opts: LocalOptions): void {
    this.lastLocal = opts;
    this.startSession(
      new LocalSession(opts, {
        exit: () => this.leaveSession(),
        restart: () => this.startLocal(opts),
        watchReplay: (bytes) => this.watchReplay(decodeReplay(bytes), () => (this.lastLocal ? this.startLocal(this.lastLocal) : this.showMenu())),
      }),
    );
  }

  startTraining(): void {
    const profile = settings.get().profile;
    this.startLocal({
      mode: 'training',
      title: 'Training',
      settings: trainingSettings(),
      physics: getPhysicsPreset(settings.get().gameplay.physicsPreset).config,
      slots: [{ id: 1, team: TEAM_RED, control: 'p1', name: profile.name, avatar: profile.avatar, difficulty: 'normal' }],
      tickRate: 60,
    });
  }

  watchReplay(data: ReplayData, onExit?: () => void): void {
    this.startSession(
      new ReplaySession(data, () => {
        this.view?.destroy();
        this.view = null;
        if (onExit) onExit();
        else this.showReplays();
      }),
    );
  }

  // ------------------------------------------------------------------ online

  private showBusy(text: string, onCancel: () => void): void {
    this.busy?.close();
    this.busy = openModal(document.body, text, h('div', { class: 'spinner' }), [{ label: 'Cancel', onClick: onCancel }]);
  }

  private hideBusy(): void {
    this.busy?.close();
    this.busy = null;
  }

  private async resolveServer(choice: string): Promise<string | null> {
    if (choice !== 'auto') return choice;
    const best = await pickServer();
    return best?.url ?? null;
  }

  private async quickPlay(): Promise<void> {
    let cancelled = false;
    this.showBusy('Finding a match…', () => {
      cancelled = true;
      this.hideBusy();
    });
    const servers = (await probeAll()).filter((s) => s.online);
    if (cancelled) return;
    if (!servers.length) {
      this.hideBusy();
      toast('No online server reachable. Starting an offline match against bots.', 'info', 5000);
      this.setScreen(localSetupScreen(() => this.showMenu(), (opts) => this.startLocal(opts)));
      return;
    }
    // Best open public room: lowest ping, has space, no password, prefer rooms with players.
    let best: { server: string; room: RoomListing; score: number } | null = null;
    for (const s of servers) {
      for (const r of s.rooms) {
        if (r.hasPassword || r.players >= r.maxPlayers) continue;
        const score = (s.ping ?? 500) - r.players * 15;
        if (!best || score < best.score) best = { server: s.url, room: r, score };
      }
    }
    this.hideBusy();
    if (best) await this.goOnline(best.server, { t: 'join', code: best.room.code, password: '' }, `Joining ${best.room.name}…`);
    else await this.goOnline(servers[0]!.url, { t: 'create', room: { name: `${settings.get().profile.name}'s room`, isPublic: true } }, 'Creating a room…');
  }

  private async createRoom(serverChoice: string, input: RoomSettingsInput): Promise<void> {
    const server = await this.resolveServer(serverChoice);
    if (!server) return void toast('No game server reachable', 'error');
    await this.goOnline(server, { t: 'create', room: input }, 'Creating room…');
  }

  private async joinWithPasswordRetry(serverChoice: string, code: string, password: string, askFirst = false): Promise<void> {
    if (askFirst && !password) {
      const pw = await this.askPassword();
      if (pw === null) return;
      password = pw;
    }
    const server = await this.resolveServer(serverChoice);
    if (!server) return void toast('No game server reachable', 'error');
    const result = await this.goOnline(server, { t: 'join', code, password }, `Joining ${code}…`);
    if (result === 'bad_password') {
      const pw = await this.askPassword();
      if (pw !== null) await this.joinWithPasswordRetry(server, code, pw);
    }
  }

  private askPassword(): Promise<string | null> {
    return new Promise((resolve) => {
      const input = textInput('', { type: 'password', placeholder: 'Room password', maxLength: 32 });
      const m = openModal(document.body, 'Password required', input, [
        {
          label: 'Join',
          primary: true,
          onClick: () => {
            m.close();
            resolve(input.value);
          },
        },
        {
          label: 'Cancel',
          onClick: () => {
            m.close();
            resolve(null);
          },
        },
      ]);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          m.close();
          resolve(input.value);
        }
      });
      setTimeout(() => input.focus(), 0);
    });
  }

  /** Connects, performs create/join/rejoin and starts the online session. Returns an error code on failure. */
  private async goOnline(server: string, action: ClientControl, busyText: string): Promise<string | null> {
    const net = new NetClient(server);
    let cancelled = false;
    this.showBusy(busyText, () => {
      cancelled = true;
      net.close();
      this.hideBusy();
    });
    try {
      await net.connect();
      if (cancelled) return 'cancelled';
      const joined = await new Promise<JoinedInfo>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The server did not respond in time')), JOIN_TIMEOUT_MS);
        net.handlers.control = (msg: ServerControl) => {
          if (msg.t === 'joined') {
            clearTimeout(timer);
            resolve({ code: msg.code, playerId: msg.playerId, token: msg.token, room: msg.room });
          } else if (msg.t === 'error') {
            clearTimeout(timer);
            const err = new Error(msg.message) as Error & { code?: string };
            err.code = msg.code;
            reject(err);
          }
        };
        net.handlers.state = (state, reason) => {
          if (state === 'closed') {
            clearTimeout(timer);
            reject(new Error(reason || 'Connection closed'));
          }
        };
        net.sendControl(action);
      });
      if (cancelled) {
        net.close();
        return 'cancelled';
      }
      this.hideBusy();
      this.startSession(new OnlineSession(net, joined, { exit: (reason) => this.leaveSession(reason) }));
      return null;
    } catch (e) {
      net.close();
      this.hideBusy();
      if (action.t === 'rejoin') sessionSet(REJOIN_KEY, null);
      const code = (e as { code?: string }).code ?? 'error';
      if (!cancelled && code !== 'bad_password') toast((e as Error).message || 'Could not connect', 'error', 5000);
      if (!this.inGame && !cancelled && action.t === 'join' && code === 'room_not_found') this.showJoin(action.code);
      return code;
    }
  }
}
