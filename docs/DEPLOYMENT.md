# Deploying Momentum

The server is a single lightweight Node.js process that serves the built browser client,
a small public HTTP API and the WebSocket game endpoint. All room state lives in memory —
there is **no database** to provision. Run one process per region, close to your players.

## Requirements

- Node.js **22.18+ or 24+** (the server runs TypeScript directly via Node's type stripping)
- Any Linux VPS with 1 vCPU / 512 MB RAM handles dozens of rooms
  (one 3v3 room ≈ 0.02 ms of CPU per tick; see `/api/metrics`)
- A domain name + TLS certificate for production (browsers require `wss://` on `https://` pages)

## Quick start on a VPS

```bash
# as root
adduser --system --group --home /opt/momentum momentum
git clone <your fork> /opt/momentum && cd /opt/momentum
npm ci && npm run build && npm test
cp .env.example .env            # edit SERVER_NAME, SERVER_REGION, TRUST_PROXY=true …
chown -R momentum:momentum /opt/momentum
cp deploy/momentum.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now momentum
journalctl -u momentum -f       # structured logs
```

Then put nginx (or Caddy) in front for TLS — `deploy/nginx.conf` is a complete example with the
WebSocket upgrade headers, disabled buffering and `tcp_nodelay`. Set `TRUST_PROXY=true` so rate limits
see real client IPs from `X-Forwarded-For`.

### Docker

```bash
docker build -t momentum .
docker run -d --name momentum --restart=always -p 8787:8787 --env-file .env momentum
```

The image runs the test suite during the build and has a `/healthz` health check.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SERVER_PORT` (or `PORT`) | `8787` | HTTP + WebSocket port |
| `HOST` | `0.0.0.0` | Bind address |
| `SERVER_NAME` | `Momentum Server` | Name in the server browser |
| `SERVER_REGION` | `Local` | Region label, e.g. `Pakistan`, `India`, `Middle East`, `Singapore`, `Europe`, `North America` |
| `TICK_RATE` | `60` | Simulation rate: `30`, `60` or `120` Hz (physics substeps are always 1/120 s) |
| `SNAPSHOT_RATE` | `min(60, TICK_RATE)` | Snapshots per second per client (10…TICK_RATE) |
| `MAX_PLAYERS` | `12` | Max members per room (2…32) |
| `MAX_ROOMS` | `200` | Room limit per process |
| `MAX_CONNECTIONS` | `2000` | Global WebSocket limit |
| `MAX_CONNECTIONS_PER_IP` | `8` | Per-IP WebSocket limit |
| `PUBLIC_ROOMS` | `1` | Always-on drop-in public rooms (auto-balance, auto-start) |
| `ROOM_PASSWORD` | – | Password for the always-on public rooms |
| `RECONNECT_WINDOW_SEC` | `30` | How long a dropped player's slot is kept |
| `EMPTY_ROOM_TIMEOUT_SEC` | `60` | Empty user rooms are destroyed after this |
| `TLS_CERT`, `TLS_KEY` | – | Paths to PEM files to serve HTTPS/WSS directly (no proxy) |
| `ALLOWED_ORIGINS` | – | Comma-separated browser origins allowed to open WebSockets (empty = any) |
| `TRUST_PROXY` | `false` | Use `X-Forwarded-For` for client IPs |
| `STATIC_DIR` | `dist/client` | Built client directory |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | `pretty` | `json` emits one JSON object per line |
| `METRICS_TOKEN` | – | Protects `GET /api/metrics` (Bearer token); without it the endpoint is localhost-only |
| `METRICS_LOG_INTERVAL_SEC` | `0` | Periodically log the metrics report |

## Regional servers

Latency matters more than anything else in this game, so run one server per region
(for example Karachi/Lahore for Pakistan, Mumbai for India, Dubai/Bahrain for the Middle East,
Singapore, Frankfurt, Virginia). Nothing is tied to a provider: any VPS with a public IP works.

Clients discover servers from three sources, merged and measured by real ping:

1. the origin that served the page;
2. `VITE_SERVERS` at build time, e.g.
   `VITE_SERVERS="https://sg.example.com,https://eu.example.com" npm run build`;
3. servers each player adds in **Settings → Network** or in the server browser.

`GET /api/info`, `/api/rooms` and `/api/ping` send `Access-Control-Allow-Origin: *`, so a client
served from one region can list and ping every other region. Room codes are unique per server;
invite links carry the server (`/?room=AB7K&server=https://sg.example.com`).

## Networking notes

- Transport: WebSocket (TCP) with `TCP_NODELAY`, binary frames for inputs/snapshots, JSON for control.
  The protocol is designed to survive loss and reordering (redundant inputs, full-state snapshots,
  sequence numbers), so it can move to WebTransport datagrams without changes to the game logic.
- Bandwidth per player at 60 snapshots/s in a 3v3: roughly 12–15 KB/s down, ~2 KB/s up.
  Lower `SNAPSHOT_RATE` (e.g. 30) to halve downstream traffic on constrained links.
- Keep the WebSocket proxy timeouts ≥ 60 s; clients ping every 500 ms.

## Monitoring & logging

- `GET /healthz` → `ok` (liveness).
- `GET /api/metrics` → tick duration (avg/max), network processing time, rooms, players,
  connections, messages/bytes in/out, invalid packets, rate-limit hits, goals, completed matches, memory.
- Logged events: `server_started`, `room_created`, `room_destroyed`, `player_connected`,
  `player_connection_lost`, `player_reconnected`, `player_disconnected`, `match_started`,
  `goal_scored`, `match_completed`, `match_stopped`, `network_error`, `invalid_packet`,
  `client_dropped_for_abuse`, `tick_overrun`, `simulation_fault`, `room_crashed`.
- With `LOG_FORMAT=json` the logs can be shipped as-is to Loki, CloudWatch, Datadog, etc.

## Security checklist

- Serve the page over HTTPS so the client uses `wss://`.
- Set `TRUST_PROXY=true` only when a proxy you control sets `X-Forwarded-For`.
- Optionally restrict `ALLOWED_ORIGINS` to the domains that host your client.
- The server never accepts positions, velocities, scores, timers or team assignments from clients;
  it validates every message (size, schema, rate) and drops abusive connections automatically.
- Protect `/api/metrics` with `METRICS_TOKEN` if the port is reachable from the internet.

## Database

None is needed: rooms, matches and replays are in memory. If you later add accounts, statistics,
match history, bans or leaderboards, add a database next to the server — never inside the tick loop.
