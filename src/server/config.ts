import { DEFAULT_TICK_RATE, SUPPORTED_TICK_RATES } from '../shared/constants/game.ts';

export interface ServerConfig {
  port: number;
  host: string;
  serverName: string;
  region: string;
  maxPlayersPerRoom: number;
  maxRooms: number;
  maxConnections: number;
  maxConnectionsPerIp: number;
  tickRate: number;
  snapshotRate: number;
  /** Password applied to the persistent public rooms (empty = open). */
  roomPassword: string;
  /** Number of always-on public rooms created at startup. */
  publicRooms: number;
  reconnectWindowMs: number;
  emptyRoomTimeoutMs: number;
  staticDir: string;
  tlsCert: string;
  tlsKey: string;
  allowedOrigins: string[];
  trustProxy: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logFormat: 'pretty' | 'json';
  metricsToken: string;
  metricsLogIntervalSec: number;
}

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`Environment variable ${name} must be a number`);
  return Math.min(max, Math.max(min, v));
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes';
}

export function loadConfig(): ServerConfig {
  const tickRate = num('TICK_RATE', DEFAULT_TICK_RATE, 30, 120);
  if (!(SUPPORTED_TICK_RATES as readonly number[]).includes(tickRate)) {
    throw new Error(`TICK_RATE must be one of ${SUPPORTED_TICK_RATES.join(', ')}`);
  }
  const snapshotRate = num('SNAPSHOT_RATE', Math.min(60, tickRate), 10, tickRate);
  const level = str('LOG_LEVEL', 'info');
  return {
    port: num('SERVER_PORT', num('PORT', 8787, 1, 65535), 1, 65535),
    host: str('HOST', '0.0.0.0'),
    serverName: str('SERVER_NAME', 'Momentum Server'),
    region: str('SERVER_REGION', 'Local'),
    maxPlayersPerRoom: num('MAX_PLAYERS', 12, 2, 32),
    maxRooms: num('MAX_ROOMS', 200, 1, 10000),
    maxConnections: num('MAX_CONNECTIONS', 2000, 1, 100000),
    maxConnectionsPerIp: num('MAX_CONNECTIONS_PER_IP', 8, 1, 1000),
    tickRate,
    snapshotRate,
    roomPassword: str('ROOM_PASSWORD', ''),
    publicRooms: num('PUBLIC_ROOMS', 1, 0, 50),
    reconnectWindowMs: num('RECONNECT_WINDOW_SEC', 30, 0, 600) * 1000,
    emptyRoomTimeoutMs: num('EMPTY_ROOM_TIMEOUT_SEC', 60, 0, 3600) * 1000,
    staticDir: str('STATIC_DIR', 'dist/client'),
    tlsCert: str('TLS_CERT', ''),
    tlsKey: str('TLS_KEY', ''),
    allowedOrigins: str('ALLOWED_ORIGINS', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    trustProxy: bool('TRUST_PROXY', false),
    logLevel: (['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info') as ServerConfig['logLevel'],
    logFormat: str('LOG_FORMAT', 'pretty') === 'json' ? 'json' : 'pretty',
    metricsToken: str('METRICS_TOKEN', ''),
    metricsLogIntervalSec: num('METRICS_LOG_INTERVAL_SEC', 0, 0, 86400),
  };
}

/** Config for tests / embedding: defaults without reading the environment. */
export function defaultConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    serverName: 'Test Server',
    region: 'Local',
    maxPlayersPerRoom: 12,
    maxRooms: 50,
    maxConnections: 100,
    maxConnectionsPerIp: 50,
    tickRate: 60,
    snapshotRate: 60,
    roomPassword: '',
    publicRooms: 0,
    reconnectWindowMs: 30_000,
    emptyRoomTimeoutMs: 60_000,
    staticDir: 'dist/client',
    tlsCert: '',
    tlsKey: '',
    allowedOrigins: [],
    trustProxy: false,
    logLevel: 'error',
    logFormat: 'pretty',
    metricsToken: '',
    metricsLogIntervalSec: 0,
    ...overrides,
  };
}
