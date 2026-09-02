import { fetchWorldOnline, type RubinotOnlinePlayer } from '../scrapers/rubinot.js';

export interface OnlineEvent {
  type: 'login' | 'logout' | 'levelup';
  player: string;
  world: string;
  level: number;
  previousLevel?: number;
  vocation?: string;
}

interface PlayerSnapshot {
  level: number;
  vocation: string;
}

export class OnlineTracker {
  private prev = new Map<string, PlayerSnapshot>();
  private initialized = false;

  constructor(private readonly worldName: string) {}

  async poll(signal?: AbortSignal): Promise<OnlineEvent[]> {
    const detail = await fetchWorldOnline(this.worldName, signal);
    const current = new Map<string, PlayerSnapshot>();
    for (const p of detail.players) {
      current.set(p.name, { level: p.level, vocation: p.vocation });
    }

    const events: OnlineEvent[] = [];

    if (this.initialized) {
      for (const [name, snap] of current) {
        const old = this.prev.get(name);
        if (!old) {
          events.push({
            type: 'login',
            player: name,
            world: this.worldName,
            level: snap.level,
            vocation: snap.vocation,
          });
        } else if (snap.level > old.level) {
          events.push({
            type: 'levelup',
            player: name,
            world: this.worldName,
            level: snap.level,
            previousLevel: old.level,
            vocation: snap.vocation,
          });
        }
      }

      for (const [name, snap] of this.prev) {
        if (!current.has(name)) {
          events.push({
            type: 'logout',
            player: name,
            world: this.worldName,
            level: snap.level,
            vocation: snap.vocation,
          });
        }
      }
    }

    this.prev = current;
    this.initialized = true;
    return events;
  }

  isOnline(name: string): boolean {
    return this.prev.has(name);
  }

  getPlayer(name: string): PlayerSnapshot | undefined {
    return this.prev.get(name);
  }

  get onlineCount(): number {
    return this.prev.size;
  }

  get onlinePlayers(): string[] {
    return [...this.prev.keys()];
  }
}
