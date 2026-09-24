export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS: Record<LogLevel, string> = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/**
 * Structured event logger. `json` format emits one JSON object per line
 * (ready for journald / Loki / CloudWatch); `pretty` is for terminals.
 */
export function createLogger(level: LogLevel, format: 'pretty' | 'json', sink: (line: string) => void = (l) => process.stdout.write(l + '\n')): Logger {
  const min = ORDER[level];
  const log = (lvl: LogLevel, event: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[lvl] < min) return;
    const time = new Date().toISOString();
    if (format === 'json') {
      sink(JSON.stringify({ time, level: lvl, event, ...fields }));
      return;
    }
    const kv = Object.entries(fields)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v)}`)
      .join(' ');
    sink(`${time.slice(11, 23)} ${COLORS[lvl]}${lvl.toUpperCase().padEnd(5)}\x1b[0m ${event}${kv ? ' ' + kv : ''}`);
  };
  return {
    debug: (e, f) => log('debug', e, f),
    info: (e, f) => log('info', e, f),
    warn: (e, f) => log('warn', e, f),
    error: (e, f) => log('error', e, f),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
