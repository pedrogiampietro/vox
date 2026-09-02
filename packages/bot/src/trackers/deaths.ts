import { fetchDeaths, type RubinotDeath } from '../scrapers/rubinot.js';

export interface DeathEvent {
  victim: string;
  level: number;
  killedBy: string;
  killerIsPlayer: boolean;
  world: string;
  timestamp: number;
}

export class DeathTracker {
  private seenKeys = new Set<string>();
  private initialized = false;

  private key(d: RubinotDeath): string {
    return `${d.victim}|${d.time}|${d.killed_by}`;
  }

  async poll(signal?: AbortSignal): Promise<DeathEvent[]> {
    const page = await fetchDeaths(1, signal);
    const newDeaths: DeathEvent[] = [];

    for (const d of page.data) {
      const k = this.key(d);
      if (this.seenKeys.has(k)) continue;
      this.seenKeys.add(k);
      if (this.initialized) {
        newDeaths.push({
          victim: d.victim,
          level: d.level,
          killedBy: d.killed_by,
          killerIsPlayer: d.is_player === 1,
          world: d.worldName,
          timestamp: Number(d.time),
        });
      }
    }

    if (!this.initialized) this.initialized = true;

    if (this.seenKeys.size > 5000) {
      const all = [...this.seenKeys];
      this.seenKeys = new Set(all.slice(-2500));
    }

    return newDeaths;
  }
}
