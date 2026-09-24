import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { GAME_VERSION, PROTOCOL_VERSION } from '../../shared/constants/game.ts';
import type { ServerConfig } from '../config.ts';
import type { Metrics } from '../observability/metrics.ts';
import type { RoomManager } from '../rooms/room-manager.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
};

export interface HttpDeps {
  config: ServerConfig;
  manager: RoomManager;
  metrics: Metrics;
  connections: () => number;
}

function json(res: ServerResponse, status: number, body: unknown, cors = true): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(cors ? { 'Access-Control-Allow-Origin': '*' } : {}),
    ...SECURITY_HEADERS,
  });
  res.end(data);
}

const NOT_BUILT_PAGE = `<!doctype html><meta charset="utf-8"><title>Momentum server</title>
<body style="font-family:system-ui;background:#0d1220;color:#dfe7ff;padding:40px">
<h1>Momentum game server is running</h1>
<p>The browser client has not been built yet. Either run <code>npm run build</code> and reload,
or use <code>npm run dev</code> and open the Vite dev server (default <a style="color:#7ce0c3" href="http://localhost:5173">http://localhost:5173</a>).</p>`;

/** Creates the HTTP request handler: public API + static client files. */
export function createHttpHandler(deps: HttpDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const root = resolve(deps.config.staticDir);
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (req.method === 'OPTIONS' && path.startsWith('/api/')) {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' });
      res.end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, SECURITY_HEADERS);
      res.end();
      return;
    }

    switch (path) {
      case '/healthz':
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('ok');
        return;
      case '/api/ping':
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
        res.end('pong');
        return;
      case '/api/info':
        json(res, 200, {
          name: deps.config.serverName,
          region: deps.config.region,
          version: GAME_VERSION,
          protocol: PROTOCOL_VERSION,
          rooms: deps.manager.rooms.size,
          players: deps.manager.playerCount,
          tickRate: deps.config.tickRate,
        });
        return;
      case '/api/rooms':
        json(res, 200, { server: { name: deps.config.serverName, region: deps.config.region }, rooms: deps.manager.listPublic() });
        return;
      case '/api/metrics': {
        const token = deps.config.metricsToken;
        const auth = req.headers.authorization ?? '';
        const remote = req.socket.remoteAddress ?? '';
        const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
        if (token ? auth !== `Bearer ${token}` : !local) {
          json(res, 403, { error: 'forbidden' }, false);
          return;
        }
        json(res, 200, deps.metrics.report({ rooms: deps.manager.rooms.size, players: deps.manager.playerCount, connections: deps.connections() }), false);
        return;
      }
    }

    if (path.startsWith('/api/')) {
      json(res, 404, { error: 'not found' });
      return;
    }
    serveStatic(root, path, req, res);
  };
}

function serveStatic(root: string, path: string, req: IncomingMessage, res: ServerResponse): void {
  if (!existsSync(join(root, 'index.html'))) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
    res.end(NOT_BUILT_PAGE);
    return;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    res.writeHead(400, SECURITY_HEADERS);
    res.end();
    return;
  }
  let file = normalize(join(root, decoded));
  // Path traversal protection.
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403, SECURITY_HEADERS);
    res.end();
    return;
  }
  let isFile = false;
  try {
    isFile = statSync(file).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    // SPA fallback (e.g. /room/AB7K deep links).
    if (extname(decoded)) {
      res.writeHead(404, SECURITY_HEADERS);
      res.end('Not found');
      return;
    }
    file = join(root, 'index.html');
  }
  const ext = extname(file);
  const hashed = /[.-][A-Za-z0-9_-]{8,}\.(js|css)$/.test(file) || file.includes(`${sep}assets${sep}`);
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...SECURITY_HEADERS,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}
