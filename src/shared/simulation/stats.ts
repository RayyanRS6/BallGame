import type { MatchStats, PlayerStats } from '../types/index.ts';

export function emptyPlayerStats(id: number): PlayerStats {
  return { id, goals: 0, assists: 0, ownGoals: 0, shots: 0, kicks: 0, touches: 0 };
}

/** Per-match statistics. Only mutated deterministically by the simulation. */
export class StatsTracker {
  private players = new Map<number, PlayerStats>();
  possessionRed = 0;
  possessionBlue = 0;

  get(id: number): PlayerStats {
    let s = this.players.get(id);
    if (!s) {
      s = emptyPlayerStats(id);
      this.players.set(id, s);
    }
    return s;
  }

  reset(): void {
    this.players.clear();
    this.possessionRed = 0;
    this.possessionBlue = 0;
  }

  snapshot(): MatchStats {
    const players = [...this.players.values()].map((p) => ({ ...p })).sort((a, b) => a.id - b.id);
    return { players, possessionRed: this.possessionRed, possessionBlue: this.possessionBlue };
  }

  restore(s: MatchStats): void {
    this.players.clear();
    for (const p of s.players) this.players.set(p.id, { ...p });
    this.possessionRed = s.possessionRed;
    this.possessionBlue = s.possessionBlue;
  }
}
