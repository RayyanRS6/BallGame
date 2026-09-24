import { loadJson, saveJson, loadString, saveString, removeKey } from './storage.ts';

export interface ReplayMeta {
  id: string;
  title: string;
  recordedAt: number;
  durationSec: number;
  scoreRed: number;
  scoreBlue: number;
  bytes: number;
}

const INDEX_KEY = 'momentum.replays.index';
const DATA_PREFIX = 'momentum.replay.';
const MAX_REPLAYS = 12;
const MAX_TOTAL_BYTES = 3_000_000;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function listReplays(): ReplayMeta[] {
  return loadJson<ReplayMeta[]>(INDEX_KEY, []).sort((a, b) => b.recordedAt - a.recordedAt);
}

/** Saves a replay into the local library (oldest entries are evicted). Returns false if storage failed. */
export function storeReplay(bytes: Uint8Array, meta: Omit<ReplayMeta, 'id' | 'bytes'>): boolean {
  const index = listReplays();
  const id = `${meta.recordedAt.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const entry: ReplayMeta = { ...meta, id, bytes: bytes.byteLength };
  index.unshift(entry);
  while (index.length > MAX_REPLAYS || index.reduce((s, r) => s + r.bytes, 0) > MAX_TOTAL_BYTES) {
    const old = index.pop();
    if (!old) break;
    removeKey(DATA_PREFIX + old.id);
    if (old.id === id) return false;
  }
  if (!saveString(DATA_PREFIX + id, toBase64(bytes))) return false;
  return saveJson(INDEX_KEY, index);
}

export function loadReplayBytes(id: string): Uint8Array | null {
  const b64 = loadString(DATA_PREFIX + id);
  if (!b64) return null;
  try {
    return fromBase64(b64);
  } catch {
    return null;
  }
}

export function deleteReplay(id: string): void {
  removeKey(DATA_PREFIX + id);
  saveJson(
    INDEX_KEY,
    listReplays().filter((r) => r.id !== id),
  );
}
