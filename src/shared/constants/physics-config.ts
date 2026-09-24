/**
 * Central physics configuration.
 *
 * Every constant that influences the simulation lives here so it can be tuned
 * (tuning panel, room presets, exported JSON) without touching gameplay code.
 *
 * Units
 *   distance  world units (u). 1 u == 1 CSS pixel at zoom 1.
 *   time      seconds (s)
 *   mass      arbitrary mass units (player = 1)
 *   impulse   mass · u/s
 *
 * Spec name mapping (PLAYER_RADIUS → playerRadius, KICK_FORCE → kickForce, ...)
 * is 1:1 in camelCase.
 */
export interface PhysicsConfig {
  /** PLAYER_RADIUS — collision radius of a player disc. */
  playerRadius: number;
  /** PLAYER_MASS — inertia of a player in collisions. */
  playerMass: number;
  /** PLAYER_ACCELERATION — acceleration produced by a full input vector (u/s²). */
  playerAcceleration: number;
  /** Multiplier on acceleration while the kick button is held (trade speed for control). */
  playerKickingAcceleration: number;
  /** PLAYER_MAX_SPEED — safety clamp only; normal play converges below it (u/s). */
  playerMaxSpeed: number;
  /** PLAYER_FRICTION — linear ground drag (1/s). Terminal speed ≈ acceleration / friction. */
  playerFriction: number;
  /** Quadratic air resistance for players (1/u). Usually 0. */
  playerAirResistance: number;
  /** PLAYER_RESTITUTION — bounciness of player contacts (product rule with the other body). */
  playerRestitution: number;

  /** BALL_RADIUS */
  ballRadius: number;
  /** BALL_MASS */
  ballMass: number;
  /** BALL_DAMPING — linear rolling drag (1/s). */
  ballDamping: number;
  /** Quadratic air resistance for the ball (1/u): fast balls slow down quicker. */
  ballAirResistance: number;
  /** BALL_FRICTION — Coulomb friction coefficient at ball contacts (generates/uses spin). */
  ballFriction: number;
  /** BALL_RESTITUTION — bounciness of the ball (product rule with the other surface). */
  ballRestitution: number;
  /** MAX_BALL_SPEED — safety clamp (u/s). */
  ballMaxSpeed: number;

  /** KICK_FORCE — impulse magnitude delivered by a kick (mass·u/s). */
  kickForce: number;
  /** KICK_RADIUS — reach beyond touching distance within which a kick connects (u). */
  kickRadius: number;
  /** KICK_COOLDOWN — minimum time between two kicks of one player (s). */
  kickCooldown: number;
  /** Fraction of the kick impulse pushed back onto the kicker (Newton's third law, softened). */
  kickRecoil: number;
  /** How much the movement input bends the kick away from the player→ball line (0..1). */
  kickAimInfluence: number;

  /** Enables angular velocity of the ball (spin, curve, friction at contacts). */
  spinEnabled: boolean;
  /** Scale of the angular impulse produced by off-centre kicks. */
  spinKickFactor: number;
  /** Magnus coefficient: how strongly spin bends the trajectory. */
  spinCurve: number;
  /** Spin decay (1/s). */
  spinDamping: number;
  /** Safety clamp for spin (rad/s). */
  ballMaxSpin: number;

  /** Restitution of the ball-area boundary walls. */
  wallRestitution: number;
  /** Restitution of goal posts. */
  postRestitution: number;
  /** Restitution of goal nets (low: nets absorb energy). */
  netRestitution: number;

  /** Contact solver iterations per micro-step (stability of simultaneous contacts). */
  solverIterations: number;
}

export type PhysicsKey = keyof PhysicsConfig;

export interface ParamMeta {
  key: PhysicsKey;
  label: string;
  group: 'Player' | 'Ball' | 'Kick' | 'Spin' | 'Arena' | 'Solver';
  min: number;
  max: number;
  step: number;
  unit?: string;
  boolean?: boolean;
  integer?: boolean;
  help: string;
}

/**
 * Bounds for every parameter. Used to validate configs received from the
 * network or imported from JSON, and to build the tuning panel.
 */
export const PHYSICS_PARAMS: readonly ParamMeta[] = [
  { key: 'playerRadius', label: 'Player radius', group: 'Player', min: 12, max: 32, step: 1, unit: 'u', help: 'Collision radius of a player.' },
  { key: 'playerMass', label: 'Player mass', group: 'Player', min: 0.2, max: 5, step: 0.05, help: 'Heavier players push harder and are pushed less.' },
  { key: 'playerAcceleration', label: 'Player acceleration', group: 'Player', min: 100, max: 2000, step: 10, unit: 'u/s²', help: 'Acceleration from a full input.' },
  { key: 'playerKickingAcceleration', label: 'Accel while kicking', group: 'Player', min: 0.2, max: 1, step: 0.05, unit: '×', help: 'Acceleration multiplier while kick is held.' },
  { key: 'playerMaxSpeed', label: 'Player max speed', group: 'Player', min: 150, max: 1500, step: 10, unit: 'u/s', help: 'Safety speed clamp.' },
  { key: 'playerFriction', label: 'Player friction', group: 'Player', min: 0.3, max: 10, step: 0.05, unit: '1/s', help: 'Ground drag. Higher = snappier stops.' },
  { key: 'playerAirResistance', label: 'Player air resistance', group: 'Player', min: 0, max: 0.01, step: 0.0001, unit: '1/u', help: 'Quadratic drag.' },
  { key: 'playerRestitution', label: 'Player restitution', group: 'Player', min: 0, max: 1, step: 0.01, help: 'Bounciness of players.' },

  { key: 'ballRadius', label: 'Ball radius', group: 'Ball', min: 6, max: 30, step: 0.5, unit: 'u', help: 'Collision radius of the ball.' },
  { key: 'ballMass', label: 'Ball mass', group: 'Ball', min: 0.05, max: 3, step: 0.01, help: 'Heavier balls resist impacts.' },
  { key: 'ballDamping', label: 'Ball damping', group: 'Ball', min: 0, max: 5, step: 0.01, unit: '1/s', help: 'Rolling drag.' },
  { key: 'ballAirResistance', label: 'Ball air resistance', group: 'Ball', min: 0, max: 0.005, step: 0.00005, unit: '1/u', help: 'Quadratic drag on fast balls.' },
  { key: 'ballFriction', label: 'Ball friction', group: 'Ball', min: 0, max: 1, step: 0.01, help: 'Surface friction at contacts (needs spin).' },
  { key: 'ballRestitution', label: 'Ball restitution', group: 'Ball', min: 0, max: 1, step: 0.01, help: 'Bounciness of the ball.' },
  { key: 'ballMaxSpeed', label: 'Ball max speed', group: 'Ball', min: 300, max: 3000, step: 10, unit: 'u/s', help: 'Safety speed clamp.' },

  { key: 'kickForce', label: 'Kick force', group: 'Kick', min: 0, max: 1000, step: 1, unit: 'm·u/s', help: 'Impulse of a kick.' },
  { key: 'kickRadius', label: 'Kick radius', group: 'Kick', min: 0, max: 30, step: 0.5, unit: 'u', help: 'Extra reach beyond touching.' },
  { key: 'kickCooldown', label: 'Kick cooldown', group: 'Kick', min: 0, max: 2, step: 0.01, unit: 's', help: 'Minimum time between kicks.' },
  { key: 'kickRecoil', label: 'Kick recoil', group: 'Kick', min: 0, max: 1, step: 0.01, help: 'Fraction of the impulse applied back to the kicker.' },
  { key: 'kickAimInfluence', label: 'Kick aim influence', group: 'Kick', min: 0, max: 1, step: 0.01, help: 'How much movement input bends the kick direction.' },

  { key: 'spinEnabled', label: 'Spin enabled', group: 'Spin', min: 0, max: 1, step: 1, boolean: true, help: 'Enable ball spin and curve.' },
  { key: 'spinKickFactor', label: 'Kick spin', group: 'Spin', min: 0, max: 3, step: 0.05, help: 'Spin from off-centre kicks.' },
  { key: 'spinCurve', label: 'Curve (Magnus)', group: 'Spin', min: 0, max: 0.2, step: 0.001, help: 'How strongly spin bends the path.' },
  { key: 'spinDamping', label: 'Spin damping', group: 'Spin', min: 0, max: 10, step: 0.05, unit: '1/s', help: 'Spin decay.' },
  { key: 'ballMaxSpin', label: 'Max spin', group: 'Spin', min: 0, max: 200, step: 1, unit: 'rad/s', help: 'Safety spin clamp.' },

  { key: 'wallRestitution', label: 'Wall restitution', group: 'Arena', min: 0, max: 1, step: 0.01, help: 'Bounciness of boundary walls.' },
  { key: 'postRestitution', label: 'Post restitution', group: 'Arena', min: 0, max: 1, step: 0.01, help: 'Bounciness of goal posts.' },
  { key: 'netRestitution', label: 'Net restitution', group: 'Arena', min: 0, max: 1, step: 0.01, help: 'Bounciness of goal nets.' },

  { key: 'solverIterations', label: 'Solver iterations', group: 'Solver', min: 1, max: 8, step: 1, integer: true, help: 'Contact iterations per micro-step.' },
];

/** The default "Classic" tuning: momentum-driven, low bounce, mild spin. */
export const DEFAULT_PHYSICS: Readonly<PhysicsConfig> = Object.freeze({
  playerRadius: 22,
  playerMass: 1,
  playerAcceleration: 600,
  playerKickingAcceleration: 0.7,
  playerMaxSpeed: 600,
  playerFriction: 2.5,
  playerAirResistance: 0,
  playerRestitution: 0.5,

  ballRadius: 14,
  ballMass: 0.5,
  ballDamping: 0.6,
  ballAirResistance: 0.0002,
  ballFriction: 0.12,
  ballRestitution: 0.5,
  ballMaxSpeed: 1500,

  kickForce: 245,
  kickRadius: 6,
  kickCooldown: 0.08,
  kickRecoil: 0.1,
  kickAimInfluence: 0.25,

  spinEnabled: true,
  spinKickFactor: 1,
  spinCurve: 0.02,
  spinDamping: 1.2,
  ballMaxSpin: 60,

  wallRestitution: 1,
  postRestitution: 0.5,
  netRestitution: 0.1,

  solverIterations: 2,
});

export interface PhysicsPreset {
  id: string;
  name: string;
  description: string;
  config: PhysicsConfig;
}

function preset(id: string, name: string, description: string, overrides: Partial<PhysicsConfig>): PhysicsPreset {
  return { id, name, description, config: { ...DEFAULT_PHYSICS, ...overrides } };
}

export const PHYSICS_PRESETS: readonly PhysicsPreset[] = [
  preset('classic', 'Classic', 'Balanced momentum football with subtle curve.', {}),
  preset('pure', 'Pure', 'No spin, no aim bending: shots go exactly along the player→ball line.', {
    spinEnabled: false,
    kickAimInfluence: 0,
    kickRecoil: 0,
    ballAirResistance: 0,
  }),
  preset('arcade', 'Arcade', 'Faster players, harder kicks, livelier bounces.', {
    playerAcceleration: 820,
    playerFriction: 2.7,
    kickForce: 300,
    ballRestitution: 0.7,
    ballDamping: 0.45,
    spinCurve: 0.03,
  }),
  preset('precision', 'Precision', 'Heavier ball, dead bounces, snappy stops — for competitive play.', {
    playerFriction: 3.2,
    playerAcceleration: 720,
    ballMass: 0.65,
    ballRestitution: 0.35,
    ballDamping: 0.75,
    kickForce: 290,
    kickAimInfluence: 0.15,
    spinCurve: 0.012,
  }),
  preset('ice', 'Ice Rink', 'Low friction everywhere. Momentum is king.', {
    playerFriction: 0.9,
    playerAcceleration: 330,
    ballDamping: 0.2,
    ballFriction: 0.03,
  }),
  preset('spin', 'Banana', 'Exaggerated spin and curve for trick shots.', {
    kickAimInfluence: 0.4,
    spinKickFactor: 1.6,
    spinCurve: 0.04,
    spinDamping: 0.8,
    ballFriction: 0.25,
  }),
];

export function getPhysicsPreset(id: string): PhysicsPreset {
  return PHYSICS_PRESETS.find((p) => p.id === id) ?? PHYSICS_PRESETS[0]!;
}

/**
 * Validates and clamps an untrusted physics configuration.
 * Unknown keys are dropped, missing/invalid values fall back to defaults.
 */
export function sanitizePhysicsConfig(input: unknown, base: PhysicsConfig = DEFAULT_PHYSICS): PhysicsConfig {
  const out: PhysicsConfig = { ...base };
  if (typeof input !== 'object' || input === null) return out;
  const src = input as Record<string, unknown>;
  for (const meta of PHYSICS_PARAMS) {
    const v = src[meta.key];
    if (meta.boolean) {
      if (typeof v === 'boolean') (out as unknown as Record<string, unknown>)[meta.key] = v;
      else if (v === 0 || v === 1) (out as unknown as Record<string, unknown>)[meta.key] = v === 1;
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    let n = Math.min(meta.max, Math.max(meta.min, v));
    if (meta.integer) n = Math.round(n);
    (out as unknown as Record<string, number>)[meta.key] = n;
  }
  return out;
}

export function physicsEquals(a: PhysicsConfig, b: PhysicsConfig): boolean {
  for (const meta of PHYSICS_PARAMS) if (a[meta.key] !== b[meta.key]) return false;
  return true;
}
