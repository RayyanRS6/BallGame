import { PROTOCOL_VERSION } from '../../shared/constants/game.ts';
import { LinkSimulator } from '../../shared/net/link-simulator.ts';
import { parseServerControl, type ClientControl, type ServerControl } from '../../shared/protocol/control.ts';
import { decodePong, decodeSnapshot, encodePing, MSG_PONG, MSG_REPLAY, MSG_SNAPSHOT, messageType, type DecodedSnapshot } from '../../shared/protocol/messages.ts';
import { settings } from '../settings.ts';
import { ClockSync } from './clock-sync.ts';
import { NetStats } from './net-stats.ts';
import { wsUrl } from './servers.ts';

export type NetState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface NetHandlers {
  control?(msg: ServerControl): void;
  snapshot?(snap: DecodedSnapshot, bytes: number): void;
  replay?(bytes: Uint8Array): void;
  state?(state: NetState, reason: string): void;
}

type Packet = string | Uint8Array;

const PING_INTERVAL_MS = 500;
const CONNECT_TIMEOUT_MS = 8000;
const RECONNECT_WINDOW_MS = 25_000;

/**
 * WebSocket client: handshake, binary/JSON routing, ping + clock sync,
 * statistics, automatic reconnection (with session restore) and an optional
 * network condition simulator for testing.
 */
export class NetClient {
  readonly serverUrl: string;
  readonly clock = new ClockSync();
  readonly stats = new NetStats();
  state: NetState = 'closed';
  handlers: NetHandlers = {};
  private ws: WebSocket | null = null;
  private pingTimer: number | null = null;
  private linkTimer: number | null = null;
  private up: LinkSimulator<Packet> | null = null;
  private down: LinkSimulator<Packet> | null = null;
  private rejoinInfo: { code: string; token: string } | null = null;
  private intentional = false;
  private reconnectStarted = 0;
  private attempt = 0;
  private pendingWelcome: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private unsub: () => void;

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl;
    this.applyLinkSettings();
    this.unsub = settings.onChange(() => this.applyLinkSettings());
  }

  private applyLinkSettings(): void {
    const n = settings.get().network;
    if (!n.simEnabled) {
      // Flush anything still in flight so nothing is lost when disabling.
      this.up?.poll(Infinity, (d) => this.rawSend(d));
      this.down?.poll(Infinity, (d) => this.dispatch(d));
      this.up = this.down = null;
      if (this.linkTimer !== null) clearInterval(this.linkTimer);
      this.linkTimer = null;
      return;
    }
    const cond = { latencyMs: n.simLatency / 2, jitterMs: n.simJitter / 2, lossRate: n.simLoss / 100, duplicateRate: n.simDuplicate / 100, reorder: n.simReorder };
    if (this.up && this.down) {
      this.up.conditions = { ...cond };
      this.down.conditions = { ...cond };
    } else {
      this.up = new LinkSimulator<Packet>(cond);
      this.down = new LinkSimulator<Packet>(cond);
    }
    if (this.linkTimer === null) {
      this.linkTimer = window.setInterval(() => {
        const now = performance.now();
        this.up?.poll(now, (d) => this.rawSend(d));
        this.down?.poll(now, (d) => this.dispatch(d));
      }, 2);
    }
  }

  /** Opens the connection and completes the handshake. */
  connect(): Promise<void> {
    this.intentional = false;
    return this.open();
  }

  private open(): Promise<void> {
    this.setState(this.rejoinInfo && this.reconnectStarted ? 'reconnecting' : 'connecting', '');
    return new Promise<void>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl(this.serverUrl));
      } catch (e) {
        reject(new Error(`Cannot connect to ${this.serverUrl}: ${(e as Error).message}`));
        return;
      }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const timeout = window.setTimeout(() => {
        reject(new Error('Connection timed out'));
        ws.close();
      }, CONNECT_TIMEOUT_MS);
      this.pendingWelcome = {
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timeout);
          reject(e);
        },
      };
      ws.onopen = () => {
        const p = settings.get().profile;
        this.rawSend(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name: p.name, avatar: p.avatar } satisfies ClientControl));
      };
      ws.onmessage = (ev) => {
        const data: Packet = typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data as ArrayBuffer);
        if (this.down) this.down.send(data, performance.now(), typeof data === 'string');
        else this.dispatch(data);
      };
      ws.onerror = () => {
        /* onclose follows */
      };
      ws.onclose = (ev) => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.stopPing();
        if (this.pendingWelcome) {
          this.pendingWelcome.reject(new Error(ev.reason || 'Server unavailable'));
          this.pendingWelcome = null;
        }
        this.onClosed(ev.code, ev.reason);
      };
    });
  }

  private onClosed(code: number, reason: string): void {
    if (this.intentional) {
      this.setState('closed', 'left');
      return;
    }
    if (code === 1008 || code === 4000) {
      this.setState('closed', reason || 'Disconnected by the server');
      return;
    }
    if (!this.rejoinInfo) {
      this.setState('closed', 'Connection lost');
      return;
    }
    if (!this.reconnectStarted) this.reconnectStarted = performance.now();
    if (performance.now() - this.reconnectStarted > RECONNECT_WINDOW_MS) {
      this.setState('closed', 'Connection lost. Could not reconnect.');
      return;
    }
    this.setState('reconnecting', 'Connection lost. Attempting to reconnect…');
    const delay = Math.min(3000, 400 * 2 ** this.attempt++);
    window.setTimeout(() => {
      if (this.intentional) return;
      this.open().catch(() => {
        /* onclose schedules the next attempt */
      });
    }, delay);
  }

  private setState(state: NetState, reason: string): void {
    this.state = state;
    this.handlers.state?.(state, reason);
  }

  /** Remember how to restore the session after a drop. */
  setRejoin(code: string, token: string): void {
    this.rejoinInfo = { code, token };
  }

  private dispatch(data: Packet): void {
    if (typeof data === 'string') {
      this.stats.onReceiveOther(data.length);
      const msg = parseServerControl(data);
      if (!msg) return;
      if (msg.t === 'welcome') {
        this.startPing();
        const wasReconnect = this.reconnectStarted > 0;
        this.setState('open', '');
        this.pendingWelcome?.resolve();
        this.pendingWelcome = null;
        if (wasReconnect && this.rejoinInfo) this.sendControl({ t: 'rejoin', code: this.rejoinInfo.code, token: this.rejoinInfo.token });
        this.reconnectStarted = 0;
        this.attempt = 0;
      }
      if (msg.t === 'error' && msg.code === 'version_mismatch') this.pendingWelcome?.reject(new Error(msg.message));
      this.handlers.control?.(msg);
      return;
    }
    switch (messageType(data)) {
      case MSG_SNAPSHOT: {
        const snap = decodeSnapshot(data);
        if (snap) this.handlers.snapshot?.(snap, data.byteLength);
        break;
      }
      case MSG_PONG: {
        this.stats.onReceiveOther(data.byteLength);
        const pong = decodePong(data);
        if (pong) this.clock.addSample(pong.clientTime, pong.serverTime, performance.now());
        break;
      }
      case MSG_REPLAY:
        this.stats.onReceiveOther(data.byteLength);
        this.handlers.replay?.(data.subarray(1));
        break;
    }
  }

  private startPing(): void {
    this.stopPing();
    const ping = () => this.sendBinary(encodePing(performance.now(), this.clock.srtt));
    ping();
    this.pingTimer = window.setInterval(ping, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private rawSend(data: Packet): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(data);
  }

  sendControl(msg: ClientControl): void {
    const text = JSON.stringify(msg);
    this.stats.onSend(text.length);
    if (this.up) this.up.send(text, performance.now(), true);
    else this.rawSend(text);
  }

  sendBinary(data: Uint8Array): void {
    this.stats.onSend(data.byteLength);
    if (this.up) this.up.send(data, performance.now(), false);
    else this.rawSend(data);
  }

  get connected(): boolean {
    return this.state === 'open';
  }

  close(): void {
    this.intentional = true;
    this.stopPing();
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.rawSend(JSON.stringify({ t: 'leave' }));
      this.ws?.close(1000, 'bye');
    } catch {
      /* ignore */
    }
    this.ws = null;
    if (this.linkTimer !== null) clearInterval(this.linkTimer);
    this.linkTimer = null;
    this.unsub();
    this.setState('closed', 'left');
  }
}
