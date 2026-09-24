# Physics model and tuning

All constants live in [`src/shared/constants/physics-config.ts`](../src/shared/constants/physics-config.ts)
(`PhysicsConfig`, `DEFAULT_PHYSICS`, `PHYSICS_PARAMS` bounds, `PHYSICS_PRESETS`). Gameplay code never
hard-codes a physical value. Units: world units (u ≈ 1 CSS px at zoom 1), seconds, player mass = 1.

## Bodies

| Body | Shape | Notes |
|---|---|---|
| Player | disc, no rotation | acceleration from input, linear ground drag, optional quadratic air drag |
| Ball | disc with angular velocity | drag, air resistance, contact friction, Magnus curve, spin decay |
| Ball-area walls | segments (ball only) | touch lines and goal lines with gaps for the goal mouths |
| Goal nets | segments (everyone) | low restitution — nets absorb the ball |
| Posts | static circles | the ball can ricochet off the woodwork |
| Outer boundary | half-planes | players may leave the lines, nobody can leave the arena; tunnelling impossible |
| Kickoff barrier | segments (players only) | centre line + half circle, active until the ball is touched (or 10 s) |

## Movement

```
a = normalize_if_longer_than_1(input) · playerAcceleration · (kick held ? playerKickingAcceleration : 1)
v += a·h                      (h = 1/120 s)
v *= 1 − playerFriction·h − playerAirResistance·|v|·h
```

Terminal speed ≈ `playerAcceleration / playerFriction` (default 600 / 2.5 = 240 u/s), reached in
≈ 1 s, and 63 % of it in 0.4 s. `playerMaxSpeed` is only a safety clamp — normal play never hits it.
Diagonal input is normalised, so it is never faster than a cardinal direction.

## Collisions

Sequential impulses with restitution `e = eA · eB` (product rule) and full positional correction split
by inverse mass. For disc A and disc B with normal n (A→B):

```
vn = (vB − vA)·n                  if vn < 0 (approaching):
jn = −(1 + e)·vn / (1/mA + 1/mB)
vA −= jn·n/mA,  vB += jn·n/mB
```

Consequences you can feel: a player running into the ball transfers its momentum (moving player ⇒
strong hit, standing player ⇒ small deflection), the resulting direction follows the contact normal
(hit it off-centre to deflect it sideways), and heavier players push harder.

With spin enabled, a Coulomb friction impulse (bounded by `ballFriction · jn`) acts along the contact
tangent, exchanging tangential velocity and spin — glancing touches spin the ball, spinning balls
kick off walls differently.

Energy safety: restitution ∈ [0, 1], the Magnus rotation is renormalised so it never adds speed, and
speed/spin clamps exist as a last resort. Tests verify that bounces never gain energy.

## Kick

Holding kick arms it; the kick fires on the first tick the ball is within `kickRadius` of touching
(one kick per press, then `kickCooldown`).

```
n   = unit(ball − player)
dir = unit(n + kickAimInfluence · input)          (never pointing back into the kicker)
ball.v += dir · kickForce / ballMass              (impulse — existing momentum is preserved)
player.v −= dir · kickForce · kickRecoil / playerMass
ball.w += spinKickFactor · (r × J) / I            (r = contact point −n·R)
```

So the shot direction is mostly decided by *where you are* relative to the ball (positioning skill),
bent a little by *where you are moving* (angled shots), and a bent shot is struck off-centre and
therefore spins and curves back (Magnus: `a = spinCurve · ω × v`).

## Continuous collision

Before each substep the world computes how many micro-steps are needed so that no body moves more
than 45 % of its radius per micro-step (max 16). With the default ball speed cap this is 1–3
micro-steps, it is deterministic (depends only on state), and the tunnelling test fires 200 balls at
maximum speed at every wall without a single escape.

## Presets

| Preset | Character |
|---|---|
| Classic | balanced, mild curve (default) |
| Pure | no spin, no aim bending — shots go exactly along the player→ball line |
| Arcade | faster players, harder kicks, livelier bounces |
| Precision | heavier ball, dead bounces, snappy stops |
| Ice Rink | low friction everywhere |
| Banana | exaggerated curve for trick shots |

## Tuning workflow

1. **Training** (main menu): free play, no timer. Tools: reset ball (R), ball to me (B), launch the
   ball at me with adjustable speed (L), reset players (T), goalkeeper or sparring bot, debug overlay
   (F3: collision bodies, goal sensors, velocity vectors, contact points and normals, FPS/TPS,
   positions, velocities, collision count, micro-steps).
2. The **Physics tuning** panel edits every parameter live within validated bounds.
3. **Export JSON / Copy** the result. A room host can use it as custom physics; the server clamps
   every value (`sanitizePhysicsConfig`). To make it the default, paste it into `DEFAULT_PHYSICS`.
4. Run `npm test` — the physics suite checks acceleration, friction, diagonal normalisation,
   collisions, bounces, kicks, tunnelling, energy and long random-play stability.
