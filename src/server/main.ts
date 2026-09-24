/**
 * Momentum game server entry point.
 *
 *   npm run server          (development)
 *   npm start               (production, serves dist/client)
 *
 * Configuration is read from environment variables — see docs/DEPLOYMENT.md.
 */
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { GAME_VERSION } from '../shared/constants/game.ts';
import { loadConfig } from './config.ts';
import { ClientSession, type Transport } from './network/client-session.ts';
import { createHttpHandler } from './network/http.ts';
import { createLogger } from './observability/logger.ts';
import { Metrics } from './observability/metrics.ts';
import { RoomManager } from './rooms/room-manager.ts';
import { ConnectionLimiter } from './security/rate-limit.ts';

const config = loadConfig();
const logger = createLogger(config.logLevel, config.logFormat);
const metrics = new Metrics();
const now = () => performance.now();
const manager = new RoomManager({ config, logger, metrics, now });
const sessions = new Set<ClientSession>();
const limiter = new ConnectionLimiter(config.maxConnectionsPerIp);
const serverInfo = { name: config.serverName, region: config.region, version: GAME_VERSION };

for (let i = 0; i < config.publicRooms; i++) {
  manager.createRoom(
    { name: `${config.region} Arena${config.publicRooms > 1 ? ` #${i + 1}` : ''}`, isPublic: true, allowTeamSwitchDuringMatch: true, match: { teamSize: 3 } },
    { persistent: true, autoStart: true },
  );
}

const handler = createHttpHandler({ config, manager, metrics, connections: () => sessions.size });
let server: Server;
if (config.tlsCert && config.tlsKey) {
  server = createHttpsServer({ cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey) }, handler);
} else {
  server = createHttpServer(handler);
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });

function clientIp(req: IncomingMessage): string {
  if (config.trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const reject = (status: number, text: string) => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  if (url.pathname !== '/ws') return reject(404, 'Not Found');
  const origin = req.headers.origin ?? '';
  if (config.allowedOrigins.length > 0 && !config.allowedOrigins.includes(origin)) {
    logger.warn('origin_rejected', { origin });
    return reject(403, 'Forbidden');
  }
  if (sessions.size >= config.maxConnections) return reject(503, 'Service Unavailable');
  const ip = clientIp(req);
  if (!limiter.acquire(ip)) {
    logger.warn('connection_limit', { ip });
    return reject(429, 'Too Many Requests');
  }
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip));
});

function onConnection(ws: WebSocket, ip: string): void {
  const transport: Transport = {
    ip,
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    send(data) {
      if (ws.readyState === ws.OPEN) ws.send(data, { binary: typeof data !== 'string' });
    },
    close(code, reason) {
      try {
        ws.close(code, reason);
      } catch {
        ws.terminate();
      }
    },
  };
  const session = new ClientSession(transport, { manager, logger, metrics, serverInfo, now });
  sessions.add(session);
  metrics.connections = sessions.size;
  metrics.connectionsTotal++;
  logger.debug('connection_opened', { session: session.id, ip });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      session.handleMessage(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    } else {
      session.handleMessage(data.toString());
    }
  });
  ws.on('close', () => {
    session.onClose();
    sessions.delete(session);
    limiter.release(ip);
    metrics.connections = sessions.size;
    logger.debug('connection_closed', { session: session.id });
  });
  ws.on('error', (err) => logger.warn('network_error', { session: session.id, error: err.message }));
}

// ---------------------------------------------------------------- tick loop

/**
 * Fixed-rate scheduler. Each room keeps its own tick deadline; the loop wakes
 * up shortly before the earliest one. Ticks are never skipped under normal
 * load; after a long stall the room drops the backlog instead of spiralling.
 */
function loop(): void {
  manager.advance(now());
  const wait = manager.nextDue() - now();
  if (!Number.isFinite(wait)) setTimeout(loop, 50);
  else if (wait > 2) setTimeout(loop, Math.floor(wait - 1));
  else setImmediate(loop);
}
loop();

// Housekeeping: idle connections, empty rooms, metrics.
setInterval(() => {
  const t = now();
  manager.sweep(t);
  for (const s of sessions) if (t - s.lastActivity > 30_000) s.close(4001, 'Idle timeout');
}, 5000).unref();

if (config.metricsLogIntervalSec > 0) {
  setInterval(() => logger.info('metrics', metrics.report({ rooms: manager.rooms.size, players: manager.playerCount })), config.metricsLogIntervalSec * 1000).unref();
}

server.listen(config.port, config.host, () => {
  logger.info('server_started', {
    port: config.port,
    host: config.host,
    region: config.region,
    tickRate: config.tickRate,
    snapshotRate: config.snapshotRate,
    tls: Boolean(config.tlsCert),
    static: config.staticDir,
  });
});

function shutdown(signal: string): void {
  logger.info('server_stopping', { signal });
  for (const room of [...manager.rooms.values()]) manager.destroyRoom(room, 'Server restarting');
  for (const s of sessions) s.close(1012, 'Server restarting');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => logger.error('uncaught_exception', { error: String(err?.stack ?? err) }));
process.on('unhandledRejection', (err) => logger.error('unhandled_rejection', { error: String(err) }));
