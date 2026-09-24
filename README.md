<div align="center">

# ⚽ Momentum (BallGame)

**A fast, deterministic, server-authoritative 2D physics football game for the web.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B%20%7C%2024%2B-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Vite](https://img.shields.io/badge/Vite-7.0-646CFF.svg?logo=vite&logoColor=white)](https://vitejs.dev/)
[![Tests](https://img.shields.io/badge/Tests-70%2F70%20Passing-success.svg)]()
[![Multiplayer](https://img.shields.io/badge/Multiplayer-Authoritative%20WebSocket-orange.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

---

A high-performance, skill-based 2D physics football (HaxBall-style) game built from the ground up on a **custom deterministic physics engine** with a **server-authoritative**, latency-compensated multiplayer netcode. The implementation, physics math, visual identity, runtime synthesized audio, and networking protocols are 100% original with zero external physics engine bloat.

### ✨ Highlights

- 🎯 **Pure Deterministic Physics:** Impulse-based model with momentum, acceleration, friction, restitution, spin, and curve. The exact same simulation runs identically on server, client, and replays.
- 🌐 **Authoritative Multiplayer:** Clients stream raw inputs; simulation, goals, scores, timers, and collisions are strictly decided by the server.
- ⚡ **Lag Compensation:** Client-side prediction with rollback reconciliation, snapshot interpolation, time dilation, and microsecond clock synchronization.
- 🏟️ **Room & Match System:** Public server browser with ping measurement, private passworded rooms, spectators, host management, and reconnection with session restore or AI takeover.
- 🤖 **Offline & Local Modes:** Play vs AI bots, 2 players on a single keyboard/gamepad, tournament series, and dedicated interactive training grounds.
- 📹 **Bit-Exact Replays:** Lightweight input-based match recordings with seek, pause, slow-motion, and fast-forward controls.
- 🎮 **Cross-Input Support:** Remappable keyboard controls, full gamepad support (Xbox, PlayStation, generic), and responsive touch controls (virtual joystick or D-pad).
- 🛠️ **Live Dev & Physics Tuning:** Real-time debug overlay (F3) and physics tuning panel with instant JSON import/export.

## Quick start

Requires **Node.js 22.18+ or 24+** (the server runs TypeScript directly).

```bash
npm install
npm run dev        # game server on :8787 + Vite client on http://localhost:5173
```

Open http://localhost:5173 in two browser windows, create a room in one and join with the code
(or the "Copy link" invite) in the other. Everything works offline on localhost.

| Command | What it does |
|---|---|
| `npm run dev` | server (auto-restart) + client dev server with hot reload |
| `npm run server` | game server only (serves `dist/client` if built) on port 8787 |
| `npm run client` | Vite client dev server only (proxies `/ws` and `/api` to :8787) |
| `npm run build` | production client build into `dist/client` |
| `npm start` | production server (after `npm run build`), open http://localhost:8787 |
| `npm test` | automated physics, simulation, determinism, protocol, server and network tests |
| `npm run typecheck` | TypeScript type check |

## Controls

| Action | Keyboard | Gamepad | Touch |
|---|---|---|---|
| Move | WASD / arrow keys | left stick / D-pad | virtual joystick (or 8-way pad) |
| Kick | Space / X (hold to kick on contact) | A / Cross (configurable) | KICK button |
| Menu / room panel | Esc | Start | — |
| Chat (online) | Enter | — | — |
| Debug overlay | F3 or ` | — | — |
| Training tools | R reset ball · B ball to me · L launch · T reset players · H hide panels | | |
| Replays | Space pause · ←/→ seek 5 s · 1–5 speed · R restart | | |

Local 2 players: P1 = WASD + Space (or pad 1), P2 = arrows + Enter (or pad 2). All keys are
remappable in Settings → Controls.

## How it plays

Hold kick while approaching the ball — the kick fires the moment the ball is within reach, sending it
**away from your centre** (positioning is aiming). Your movement input bends the shot slightly and an
off-centre strike spins the ball so it curves. Running into the ball dribbles/pushes it with your
momentum. Holding kick also slows you a little (trade speed for control).

## Project layout

```
src/
  shared/                 runs on server, client and in tests
    constants/            physics-config.ts (all tunables, bounds, presets), game.ts
    physics/world.ts      deterministic impulse-based engine
    simulation/           GameSimulation (physics + match state machine), maps, formations,
                          bots, replays, seeded RNG, stats, settings
    protocol/             binary codec (inputs, snapshots, ping), JSON control + validation
    net/                  network condition simulator
    types/                shared data types
  server/
    main.ts               HTTP + WebSocket entry point, tick scheduler
    rooms/                Room (authoritative sim, members, broadcast), RoomManager
    match/input-buffer.ts one-input-per-tick jitter buffer
    network/              client sessions, HTTP API + static files
    security/             rate limits, abuse tracking
    observability/        structured logs, metrics
  client/
    app.ts, main.ts       navigation, bootstrap
    game/                 sessions (local / online / replay), game view, effects
    prediction/           predictor (reconciliation), interpolation buffer, time dilation
    network/              WebSocket client, clock sync, net stats, server discovery
    rendering/            canvas renderer, camera, particles, pitch cache
    input/ audio/ ui/     devices, synthesised sound, screens and overlays
tests/                    node:test suites + headless multiplayer harness
docs/                     ARCHITECTURE.md, PHYSICS.md, DEPLOYMENT.md
deploy/                   systemd unit, nginx config
```

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — simulation loop, determinism, networking model, anti-cheat, replays
- [docs/PHYSICS.md](docs/PHYSICS.md) — physics model, every parameter, presets, tuning workflow
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — VPS/Docker deployment, environment variables, TLS, regions, monitoring

## Tests

`npm test` runs 70 tests in about a second, including:

- physics: acceleration, friction, diagonal normalisation, player/player momentum, wall bounce,
  moving vs standing ball contact, perpendicular deflection, kick impulse (additive), kick range and
  latch, curve, no tunnelling at max speed, no energy gain, 20k-tick random stress, crowding
- match: countdown, freeze, goal detection (once, full crossing, posts), reset, kickoff barrier,
  timer, overtime, score limit, halftime, tournament series, stats attribution, training
- determinism: identical hashes, save/restore continuation, 30 vs 60 Hz equivalence, bit-exact replays
- protocol: exact snapshot round-trip, malformed/garbage packets, control validation, clamping
- server: rooms, passwords, full rooms, team locking, host rights and migration, bots,
  reconnection, reconnect window, AI takeover, authoritative goals, speed-hack/flood resistance,
  abusive clients dropped, replays served
- network: prediction converges at 0/20/50/100/150/200 ms RTT and with 1/5/10 % loss + jitter +
  duplication + reordering; link simulator; clock sync; interpolation buffer

## License

This project is licensed under the [MIT License](LICENSE).
