import { CAT_ALL, CAT_BALL, CAT_PLAYER, TAG_BARRIER, TAG_NET, TAG_OUTER, TAG_POST, TAG_WALL } from '../constants/game.ts';
import type { PhysicsConfig } from '../constants/physics-config.ts';
import { createSegment, type Plane, type Segment, type StaticCircle } from '../physics/world.ts';

/**
 * Arena definition in world units. The origin (0, 0) is the centre spot;
 * red defends the left goal (x < 0) and attacks towards +x.
 */
export interface MapDef {
  id: string;
  name: string;
  version: number;
  /** Half the distance between the goal lines. */
  halfWidth: number;
  /** Half the distance between the touch lines. */
  halfHeight: number;
  /** Half the width of the goal mouth (post centre to post centre). */
  goalHalfWidth: number;
  goalDepth: number;
  postRadius: number;
  centerRadius: number;
  /** How far players may run beyond the goal lines / touch lines. */
  outerMarginX: number;
  outerMarginY: number;
  recommendedTeamSize: number;
}

export const MAPS: readonly MapDef[] = [
  {
    id: 'classic',
    name: 'Classic',
    version: 1,
    halfWidth: 680,
    halfHeight: 300,
    goalHalfWidth: 100,
    goalDepth: 60,
    postRadius: 8,
    centerRadius: 90,
    outerMarginX: 110,
    outerMarginY: 70,
    recommendedTeamSize: 3,
  },
  {
    id: 'compact',
    name: 'Compact',
    version: 1,
    halfWidth: 520,
    halfHeight: 240,
    goalHalfWidth: 85,
    goalDepth: 55,
    postRadius: 8,
    centerRadius: 75,
    outerMarginX: 100,
    outerMarginY: 60,
    recommendedTeamSize: 1,
  },
  {
    id: 'stadium',
    name: 'Stadium',
    version: 1,
    halfWidth: 880,
    halfHeight: 390,
    goalHalfWidth: 120,
    goalDepth: 65,
    postRadius: 9,
    centerRadius: 110,
    outerMarginX: 120,
    outerMarginY: 80,
    recommendedTeamSize: 5,
  },
];

export function getMap(id: string): MapDef {
  return MAPS.find((m) => m.id === id) ?? MAPS[0]!;
}

export interface ArenaGeometry {
  segments: Segment[];
  planes: Plane[];
  circles: StaticCircle[];
  /** Kickoff barrier segments for red kickoff / blue kickoff. */
  barrierRed: Segment[];
  barrierBlue: Segment[];
  /** Extent of the playable area (outer planes). */
  outerX: number;
  outerY: number;
}

const BARRIER_ARC_SEGMENTS = 16;

/**
 * Points of a half circle computed with the rational parametrisation
 * ((1−t²)/(1+t²), 2t/(1+t²)) — pure arithmetic, so every JS engine produces
 * bit-identical geometry (Math.sin/cos are not guaranteed to).
 */
function halfCirclePoints(radius: number, side: 1 | -1, count: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i <= count; i++) {
    const t = -1 + (2 * i) / count;
    const d = 1 + t * t;
    pts.push((side * radius * (1 - t * t)) / d, (radius * 2 * t) / d);
  }
  return pts;
}

function buildBarrier(map: MapDef, bulgeSide: 1 | -1): Segment[] {
  const H = map.halfHeight + map.outerMarginY;
  const R = map.centerRadius;
  const out: Segment[] = [];
  const add = (ax: number, ay: number, bx: number, by: number) =>
    out.push(createSegment(ax, ay, bx, by, 0, 0, CAT_PLAYER, TAG_BARRIER));
  add(0, -H, 0, -R);
  add(0, R, 0, H);
  const pts = halfCirclePoints(R, bulgeSide, BARRIER_ARC_SEGMENTS);
  for (let i = 0; i + 3 < pts.length; i += 2) add(pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!);
  return out;
}

/** Builds the static collision geometry of an arena for a physics config. */
export function buildArena(map: MapDef, physics: PhysicsConfig): ArenaGeometry {
  const W = map.halfWidth;
  const H = map.halfHeight;
  const G = map.goalHalfWidth;
  const D = map.goalDepth;
  const wallR = physics.wallRestitution;
  const segments: Segment[] = [];

  const ballWall = (ax: number, ay: number, bx: number, by: number) =>
    segments.push(createSegment(ax, ay, bx, by, wallR, 0, CAT_BALL, TAG_WALL));
  // Ball area: touch lines and goal lines with gaps for the goal mouths.
  ballWall(-W, -H, W, -H);
  ballWall(-W, H, W, H);
  ballWall(-W, -H, -W, -G);
  ballWall(-W, G, -W, H);
  ballWall(W, -H, W, -G);
  ballWall(W, G, W, H);

  // Goal nets: solid for everyone.
  const net = (ax: number, ay: number, bx: number, by: number) =>
    segments.push(createSegment(ax, ay, bx, by, physics.netRestitution, 0, CAT_ALL, TAG_NET));
  for (const side of [-1, 1]) {
    const gx = side * W;
    const bx = side * (W + D);
    net(gx, -G, bx, -G);
    net(bx, -G, bx, G);
    net(bx, G, gx, G);
  }

  const circles: StaticCircle[] = [];
  for (const side of [-1, 1]) {
    for (const s of [-1, 1]) {
      circles.push({
        x: side * W,
        y: s * G,
        radius: map.postRadius,
        restitution: physics.postRestitution,
        friction: 0,
        mask: CAT_ALL,
        tag: TAG_POST,
        enabled: true,
      });
    }
  }

  // Outer boundary as half-spaces: impossible to tunnel through.
  const outerX = W + map.outerMarginX;
  const outerY = H + map.outerMarginY;
  const plane = (nx: number, ny: number, d: number): Plane => ({
    nx,
    ny,
    d,
    restitution: wallR,
    friction: 0,
    mask: CAT_ALL,
    tag: TAG_OUTER,
    enabled: true,
  });
  const planes: Plane[] = [plane(1, 0, -outerX), plane(-1, 0, -outerX), plane(0, 1, -outerY), plane(0, -1, -outerY)];

  // Red kicks off → the circle bulges into blue's half (+x) and vice versa.
  const barrierRed = buildBarrier(map, 1);
  const barrierBlue = buildBarrier(map, -1);
  for (const s of barrierRed) s.enabled = false;
  for (const s of barrierBlue) s.enabled = false;

  return { segments, planes, circles, barrierRed, barrierBlue, outerX, outerY };
}
