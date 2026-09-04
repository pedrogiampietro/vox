import type { GameProvider, ProviderDeath } from '../scrapers/provider.js';

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

  constructor(
    private readonly provider: GameProvider,
    private world: string,
  ) {}

  /** Reaponta pro mundo novo sem perder o que ja foi visto. */
  setWorld(world: string): void {
    this.world = world;
  }

  private key(d: ProviderDeath): string {
    return `${d.victim}|${d.timestamp}|${d.killedBy}`;
  }

  async poll(signal?: AbortSignal): Promise<DeathEvent[]> {
    const deaths = await this.provider.fetchDeaths(this.world, signal);
    const newDeaths: DeathEvent[] = [];

    for (const d of deaths) {
      const k = this.key(d);
      if (this.seenKeys.has(k)) continue;
      this.seenKeys.add(k);
      if (this.initialized) {
        newDeaths.push({ ...d });
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
