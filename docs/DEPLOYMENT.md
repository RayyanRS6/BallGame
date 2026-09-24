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

## Static client on Vercel / Netlify + separate game server

Vercel (and similar static/serverless hosts) can serve the **client**, but cannot run the game
**server**: it needs a long-lived process with WebSockets and a 60 Hz tick loop. Split the two:

1. **Client on Vercel** — `vercel.json` in the repo sets the build (`npm run build`) and the output
   directory (`dist/client`). Without it Vercel serves `dist/` and every page is a 404.
2. **Server anywhere that keeps a process running with WebSockets** — a VPS (see below), Docker host,
   Render (`render.yaml` blueprint included), Railway or Fly.io. It must be reachable over **HTTPS**,
   because a page served over `https://` may only open `wss://` connections.
3. In Vercel → Project → Settings → Environment Variables add
   `VITE_SERVERS=https://your-game-server.example.com` (comma-separate several regions) and redeploy.
   The variable is baked in at build time.

Without `VITE_SERVERS` the client assumes its own origin is the game server; on Vercel that finds
no server, so the menu reports "No game server reachable" and only the offline modes (local match,
training, replays) are available. With `VITE_SERVERS` set, the page's own origin is not probed.

## One-command server in the UAE (best for Pakistan and the Gulf)

1. Create an **Ubuntu 22.04 or 24.04** VM in a UAE region, with at least 1 full vCPU:
   Oracle Cloud *UAE East (Dubai)* / *UAE Central (Abu Dhabi)* (Always Free Ampere VM if you pick a
   UAE home region at sign-up), AWS `me-central-1`, or Azure *UAE North*.
2. In the provider's firewall / security list, allow inbound **TCP 22, 80 and 443**.
3. SSH in and run:

   ```bash
   sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/RayyanRS6/BallGame/main/deploy/setup-vps.sh)"
   ```

   It installs Node 24, Caddy (free automatic HTTPS) and the game service, and prints the server
   address — `https://<your-ip-with-dashes>.sslip.io` unless you pass `DOMAIN=your.domain`.
4. Play at that address directly, or set `VITE_SERVERS=https://<that address>` in Vercel and
   redeploy. You can keep the Render server in the list too; the server browser shows each
   player's ping to both.

Re-run the same command on the VPS to update the game to the latest commit.

## Reducing latency

Ping is almost entirely decided by **where the server runs** and **whether it gets enough CPU**.
The game's own overhead is small: the local player is predicted (moves instantly) and the server
answers pings the moment they arrive.

1. **Put the server close to the players — measure, don't guess.** Routing is not geographic.
   Measured from Karachi (Sept 2026): UAE ≈ 55 ms, Singapore ≈ 105–120 ms, Frankfurt ≈ 150 ms,
   Mumbai/Delhi 120–260 ms (Pakistan↔India traffic often detours abroad). Each player can check
   their own numbers at <https://www.cloudping.info> (AWS regions); choose the region that keeps the
   *worst* player's ping lowest. For Pakistan and the Gulf that is usually the UAE:
   AWS `me-central-1` (UAE), Azure UAE North (Dubai), Google Cloud `me-central1` (Doha) or
   Oracle Cloud Dubai / Abu Dhabi (its Always Free VM can use a UAE home region).
2. **Give it a real CPU.** A fractional vCPU (e.g. Render free = 0.1 vCPU) gets throttled: the
   process is frozen for tens of milliseconds at a time, adding lag spikes for everyone. The server
   logs `server_stalling` and reports `loopLateAvgMs` / `loopLateMaxMs` in `/api/metrics` when that
   happens. One full vCPU runs many rooms comfortably.
3. **Connect directly.** Hosts that force traffic through a CDN proxy (Render routes everything via
   Cloudflare) add an extra hop between the player's edge and the server. A VPS with its own
   domain + TLS (nginx/Caddy, see above) avoids that.
4. **Several regions for mixed groups.** Run one server per region and list them all in
   `VITE_SERVERS`; the server browser shows each player's measured ping to every region. All
   players in one match must share one server, so pick the region that is fair for the group.
5. **Client settings.** Keep Settings → Network → *Simulate network conditions* **off** — it adds
   artificial lag for testing, and the HUD warns while it is on.

To measure a deployment from your own machine:

```bash
curl -s -o /dev/null -w "%{time_connect}s connect, %{time_starttransfer}s first byte\n" https://your-server/api/ping
```

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

Clients discover servers from these sources, merged and measured by real ping:

1. `VITE_SERVERS` at build time, e.g.
   `VITE_SERVERS="https://sg.example.com,https://eu.example.com" npm run build`;
2. otherwise, the origin that served the page;
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
