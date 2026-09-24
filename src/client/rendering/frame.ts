import { TEAM_SPECTATOR, type PlayingTeam, type TeamId } from '../../shared/constants/game.ts';
import { DEFAULT_PHYSICS, type PhysicsConfig } from '../../shared/constants/physics-config.ts';
import type { PhysicsWorld } from '../../shared/physics/world.ts';
import { getMap, type MapDef } from '../../shared/simulation/maps.ts';
import { DEFAULT_MATCH_SETTINGS } from '../../shared/simulation/settings.ts';
import { emptyMatchState } from '../../shared/simulation/simulation.ts';
import type { MatchSettings, MatchStateData } from '../../shared/types/index.ts';
import type { NetHud } from '../ui/hud.ts';

export interface RenderPlayer {
  id: number;
  team: PlayingTeam;
  x: number;
  y: number;
  vx: number;
  vy: number;
  kicking: boolean;
  name: string;
  avatar: string;
  isLocal: boolean;
}

export interface Ghost {
  x: number;
  y: number;
  r: number;
  kind: 'server' | 'interp';
}

/**
 * Everything the renderer needs for one frame. Sessions fill it; the
 * renderer never reads the simulation directly (except debug geometry).
 */
export interface RenderFrame {
  map: MapDef;
  physics: PhysicsConfig;
  players: RenderPlayer[];
  ball: { x: number; y: number; vx: number; vy: number; w: number };
  match: MatchStateData;
  settings: MatchSettings;
  tickRate: number;
  localTeam: TeamId;
  focusId: number;
  /** Extra HUD sub-line (e.g. "Spectating", "Training"). */
  hudSub: string;
  net: NetHud | null;
  debug: {
    world: PhysicsWorld | null;
    ghosts: Ghost[];
    lines: string[];
  };
}

export function createFrame(): RenderFrame {
  return {
    map: getMap('classic'),
    physics: { ...DEFAULT_PHYSICS },
    players: [],
    ball: { x: 0, y: 0, vx: 0, vy: 0, w: 0 },
    match: emptyMatchState(),
    settings: { ...DEFAULT_MATCH_SETTINGS },
    tickRate: 60,
    localTeam: TEAM_SPECTATOR,
    focusId: 0,
    hudSub: '',
    net: null,
    debug: { world: null, ghosts: [], lines: [] },
  };
}

/** Reuses RenderPlayer objects to avoid per-frame allocation. */
export class PlayerPool {
  private pool: RenderPlayer[] = [];
  private used = 0;

  begin(frame: RenderFrame): void {
    this.used = 0;
    frame.players.length = 0;
  }

  next(frame: RenderFrame): RenderPlayer {
    let p = this.pool[this.used];
    if (!p) {
      p = { id: 0, team: 1, x: 0, y: 0, vx: 0, vy: 0, kicking: false, name: '', avatar: '', isLocal: false };
      this.pool.push(p);
    }
    this.used++;
    frame.players.push(p);
    return p;
  }
}
