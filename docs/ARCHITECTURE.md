# Architecture

Momentum is built in three layers, in this order of importance:

```
┌──────────────────────── shared (runs everywhere) ────────────────────────┐
│ physics/world.ts        deterministic impulse solver (discs, segments,     │
│                         half-planes, static circles, spin, CCD)            │
│ simulation/simulation   GameSimulation = physics + match state machine     │
│ simulation/ai, replay   bots (input only) · input-based replays            │
│ protocol/*              binary snapshots/inputs · validated JSON control   │
│ constants/physics-config  every tunable constant + bounds + presets        │
└────────────────────────────────────────────────────────────────────────────┘
        ▲ same code                                  ▲ same code
┌───────┴──────── server (authority) ────────┐ ┌─────┴──────── client (browser) ─────────┐
│ rooms/room.ts     simulation per room      │ │ prediction/  predictor, interpolation,   │
│ match/input-buffer one input per tick      │ │              time dilation               │
│ network/*         sessions, HTTP API, ws   │ │ network/     ws client, clock sync, stats│
│ security/*        rate limits, abuse score │ │ game/        local/online/replay sessions│
│ observability/*   logs, metrics            │ │ rendering/   canvas renderer, particles  │
└────────────────────────────────────────────┘ │ input/ audio/ ui/                         │
                                               └───────────────────────────────────────────┘
```

The renderer, audio and UI only *read* simulation output. Nothing in the client can move a body
on the server; clients only send inputs.

## Simulation loop

One **tick** (1/60 s by default) is:

```
receive/consume input (exactly one per player)
→ input vector (normalised, |v| ≤ 1) → acceleration
→ kicks (impulses on the ball, recoil on the kicker, spin from off-centre impulses)
→ 2 physics substeps of 1/120 s, each:
     integrate velocity (acceleration, Magnus curve, drag, safety clamps)
     adaptive micro-steps (no body moves > 45 % of its radius per micro-step)
     solve contacts: body–body, then walls (sequential impulses + positional correction)
     touch bookkeeping → goal sensor check
→ match state machine (timer, countdown, pauses, halftime, overtime, series)
→ quantise state to float32 (snapshots are then bit-exact)
→ broadcast snapshot (every N ticks)
```

Physics always integrates with the same 1/120 s substep, so 30/60/120 Hz servers produce the same
motion. Rendering is completely decoupled: every session keeps the previous tick's positions and the
renderer interpolates with `alpha = accumulator / tickDuration`, so the game looks smooth and behaves
identically at 30, 60, 120, 144 or 240 FPS (there is an FPS cap setting to verify this).

## Determinism

Given the same initial state, inputs, configuration and seed, the simulation produces bit-identical
results on every JavaScript engine:

- only `+ − × ÷` and `Math.sqrt` (all correctly rounded by IEEE-754) — no `sin/cos/exp` inside the
  simulation; even the arc of the kickoff barrier uses a rational parametrisation;
- bodies are processed in id order; contacts are resolved in a fixed order; no `Math.random` —
  the only randomness (kickoff coin toss) uses a seeded 32-bit PRNG stored in the state;
- state is quantised to float32 each tick, so what the client restores from a snapshot is exactly
  what the server has.

Tests assert identical hashes after thousands of ticks, identical continuation after save/restore,
and bit-exact replay reproduction including roster changes.

## Match state machine

`LOBBY → RESETTING → COUNTDOWN → PLAYING ⇄ GOAL_PAUSE / HALFTIME → MATCH_END → (next round | LOBBY)`

All match state lives in one object (`match` in `GameSimulation`) that is part of every snapshot:
phase, phase timer, score, played time, kickoff team, kickoff barrier, overtime, half, round/series
wins, last touches (for scorer/assist attribution). The server's simulation owns it; clients only
display it. Goals are detected by a sensor: the ball must be completely past the goal line inside
the goal mouth, and detection is disabled until the next kickoff, so a goal can never count twice.

## Networking

### Messages

| Direction | Type | Encoding | Content |
|---|---|---|---|
| C→S | input | binary, ≤ 30 B | newest seq + last ≤ 8 inputs (x, y as int8, kick bit) |
| C→S | ping | binary, 11 B | client time + current RTT estimate |
| S→C | pong | binary, 17 B | client time echo + server time |
| S→C | snapshot | binary, ~22 B/player + 60 B | seq, ack, input-queue depth, config version, server time, full state |
| S→C | replay | binary | encoded replay |
| both | control | JSON | hello/welcome, create/join/rejoin, teams, settings, chat, goal, match end… |

Snapshots are full state (not deltas) — at ~200 bytes for a 3v3 that is cheaper than the complexity
of delta compression, and any single snapshot is enough to resynchronise after loss.

### Server: input buffer

Each player has a jitter buffer ordered by sequence number. The server consumes **exactly one input
per tick** (repeating the last one briefly if the buffer runs dry, then neutral), acknowledges the
last consumed sequence in snapshots and reports the buffer depth. Sending inputs faster can never make
a player faster: excess inputs are dropped. Redundant inputs in every packet make loss harmless.

### Client: prediction and reconciliation

1. Each client tick: read input → stamp `seq` → simulate one tick locally → send (with the last few
   inputs for redundancy).
2. On snapshot: restore the authoritative state (tick T), drop inputs `≤ ack`, re-simulate the
   remaining ones. The result is "server truth + my unconfirmed inputs".
3. Visual corrections are smoothed (exponential decay, snap above 70 u).

The local player and, by default, the ball are predicted so touches feel immediate. Remote players
are interpolated from a snapshot buffer rendered ~2 snapshot intervals in the past (adaptive to
measured jitter), with short bounded extrapolation. Both behaviours are switchable in
Settings → Network.

### Time dilation and clock sync

Clients run their tick clock ±6 % faster/slower to keep the server's input buffer at a small target
that grows with jitter — enough to absorb jitter, small enough to add minimal latency. Clock offset is
estimated NTP-style from ping/pong using the lowest-RTT sample and slewed smoothly; interpolation uses
the estimated server time. Ping, jitter, loss (from snapshot sequence gaps), duplicates and
out-of-order packets are measured and shown in the HUD and debug overlay.

### Reconnection

A dropped player keeps their slot (and body on the pitch) for `RECONNECT_WINDOW_SEC`. The client
reconnects with exponential backoff and a session token (also kept in `sessionStorage`, so a page
reload restores the session). Optionally an AI takes over while the player is away; if the window
expires the player is removed (or permanently replaced by the AI).

## Anti-cheat

The client sends only input vectors (clamped to |v| ≤ 1) and a kick bit. Everything else — positions,
velocities, kicks (range + cooldown), goals, score, timer, team changes — is decided by the server.
The server additionally validates packet sizes and schemas, rate-limits binary and control traffic,
detects input floods, invalid sequence numbers and invalid state transitions, and keeps a decaying
abuse score per connection that disconnects persistent offenders. A sanity check resets the pitch if a
body ever becomes non-finite or leaves the arena (defence in depth — it has never triggered in tests).

## Replays

Recording stores the initial state, configuration, seed, roster changes and *changes* of each
player's input with their tick. Playback re-simulates; the player builds keyframes every 5 s once
for instant seeking, and supports pause, 0.25×–4× speed and restart. A 5-minute 3v3 is typically
40–100 KB. The server keeps the last match of each room (`getReplay`); local matches record too.

## Performance

- No allocation in the physics hot loop; particles use a fixed-size struct-of-arrays pool; render
  players are pooled; the pitch is cached to an offscreen canvas.
- A 3v3 tick costs ~10 µs on a laptop; a server core runs hundreds of rooms.
- The HUD updates DOM text only when it changes; the debug panel refreshes at 5 Hz.
