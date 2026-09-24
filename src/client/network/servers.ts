import type { RoomListing } from '../../shared/types/index.ts';
import { settings } from '../settings.ts';

export interface ServerEntry {
  url: string;
  name: string;
  region: string;
  online: boolean;
  /** Measured HTTP round-trip time (ms), null when unreachable. */
  ping: number | null;
  players: number;
  rooms: RoomListing[];
  error: string;
}

/** Accepts "host", "host:port", "http(s)://host[:port]" (and ws/wss) and returns an http(s) origin. */
export function normalizeServerUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (s.startsWith('ws://')) s = 'http://' + s.slice(5);
  else if (s.startsWith('wss://')) s = 'https://' + s.slice(6);
  else if (!/^https?:\/\//.test(s)) s = (location.protocol === 'https:' ? 'https://' : 'http://') + s;
  try {
    const u = new URL(s);
    return u.origin;
  } catch {
    return null;
  }
}

export function wsUrl(base: string): string {
  const u = new URL(base);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  return u.toString();
}

/** Same-origin server, build-time list (VITE_SERVERS) and user-added servers. */
export function knownServers(): string[] {
  const list: string[] = [location.origin];
  const env = (import.meta.env?.VITE_SERVERS as string | undefined) ?? '';
  for (const s of env.split(',')) {
    const n = normalizeServerUrl(s);
    if (n) list.push(n);
  }
  for (const s of settings.get().network.servers) {
    const n = normalizeServerUrl(s);
    if (n) list.push(n);
  }
  return [...new Set(list)];
}

async function timedFetch(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { cache: 'no-store', signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Measures ping (best of 3 HTTP round trips) and fetches info + public rooms. */
export async function probeServer(url: string, timeoutMs = 3000): Promise<ServerEntry> {
  const entry: ServerEntry = { url, name: url, region: '?', online: false, ping: null, players: 0, rooms: [], error: '' };
  try {
    const info = (await (await timedFetch(`${url}/api/info`, timeoutMs)).json()) as { name: string; region: string; players: number };
    entry.name = info.name;
    entry.region = info.region;
    entry.players = info.players;
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      await timedFetch(`${url}/api/ping`, timeoutMs);
      best = Math.min(best, performance.now() - t0);
    }
    entry.ping = Math.round(best);
    const rooms = (await (await timedFetch(`${url}/api/rooms`, timeoutMs)).json()) as { rooms: RoomListing[] };
    entry.rooms = rooms.rooms;
    entry.online = true;
  } catch (e) {
    entry.error = (e as Error).name === 'AbortError' ? 'timeout' : 'unreachable';
  }
  return entry;
}

export async function probeAll(): Promise<ServerEntry[]> {
  const results = await Promise.all(knownServers().map((u) => probeServer(u)));
  return results.sort((a, b) => (a.ping ?? 1e9) - (b.ping ?? 1e9));
}

/** Preferred server from settings, else the lowest-ping reachable one. */
export async function pickServer(): Promise<ServerEntry | null> {
  const pref = settings.get().network.preferredServer;
  const all = await probeAll();
  if (pref !== 'auto') {
    const p = all.find((s) => s.url === pref && s.online);
    if (p) return p;
  }
  return all.find((s) => s.online) ?? null;
}
