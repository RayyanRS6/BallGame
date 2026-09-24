import { DEFAULT_PHYSICS, type PhysicsConfig } from '../src/shared/constants/physics-config.ts';
import { getMap } from '../src/shared/simulation/maps.ts';
import { DEFAULT_MATCH_SETTINGS } from '../src/shared/simulation/settings.ts';
import { GameSimulation } from '../src/shared/simulation/simulation.ts';
import type { MatchSettings } from '../src/shared/types/index.ts';

export function makeSim(opts: { physics?: Partial<PhysicsConfig>; settings?: Partial<MatchSettings>; tickRate?: number; seed?: number; mapId?: string } = {}): GameSimulation {
  const settings = { ...DEFAULT_MATCH_SETTINGS, ...opts.settings };
  return new GameSimulation({
    map: getMap(opts.mapId ?? settings.mapId),
    physics: { ...DEFAULT_PHYSICS, ...opts.physics },
    settings,
    tickRate: opts.tickRate ?? 60,
    seed: opts.seed ?? 12345,
  });
}

export function speed(b: { vx: number; vy: number }): number {
  return Math.hypot(b.vx, b.vy);
}

/** Runs a simulation forward n ticks. */
export function run(sim: GameSimulation, n: number, each?: (i: number) => void): void {
  for (let i = 0; i < n; i++) {
    each?.(i);
    sim.step();
  }
}

/** Deterministic PRNG for test input generation. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
