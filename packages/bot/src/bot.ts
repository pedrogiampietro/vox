/**
 * Bot Rubinot — rastreia jogadores e posta notificacoes nos canais do v0x.
 *
 * Configuravel pelo painel admin ou por variaveis de ambiente (fallback):
 *   BOT_WORLD        world do Rubinot (ex: "Vesperia")
 *   BOT_GUILD        guild para rastrear (puxa membros automaticamente)
 *   BOT_HUNTED       nomes separados por virgula (lista manual)
 *   BOT_INTERVAL     segundos entre polls (padrao 60)
 *   BOT_CHANNEL      nome do canal no v0x para notificacoes (padrao "bot")
 */

import type { Hub } from '../../server/src/hub.js';
import { DeathTracker, type DeathEvent } from './trackers/deaths.js';
import { OnlineTracker, type OnlineEvent } from './trackers/online.js';
import { fetchGuild } from './scrapers/rubinot.js';

// ---------------------------------------------------------------- config --

export interface BotConfig {
  world: string;
  guildName: string;
  huntedNames: string[];
  intervalMs: number;
  channelName: string;
  enabled: boolean;
  globalDeaths: boolean;
  globalKills: boolean;
  globalLevelMin: number;
  summarizePresence: boolean;
  presenceSummaryMs: number;
}

export function botConfigFromEnv(): BotConfig | null {
  const world = process.env['BOT_WORLD'];
  if (!world) return null;
  return {
    world,
    guildName: process.env['BOT_GUILD'] ?? '',
    huntedNames: (process.env['BOT_HUNTED'] ?? '')
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean),
    intervalMs: (Number(process.env['BOT_INTERVAL']) || 60) * 1000,
    channelName: process.env['BOT_CHANNEL'] ?? 'bot',
    enabled: true,
    globalDeaths: true,
    globalKills: true,
    globalLevelMin: 800,
    summarizePresence: true,
    presenceSummaryMs: 5 * 60 * 1000,
  };
}

// ------------------------------------------------------------------- bot --

export class RubinotBot {
  private deaths = new DeathTracker();
  private online: OnlineTracker;
  private readonly hunted = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ac = new AbortController();
  private running = false;
  private readonly pendingLogins: OnlineEvent[] = [];
  private readonly pendingLogouts: OnlineEvent[] = [];
  private nextPresenceSummaryAt = 0;

  constructor(
    private readonly hub: Hub,
    private cfg: BotConfig,
  ) {
    this.online = new OnlineTracker(cfg.world);
    for (const n of cfg.huntedNames) this.hunted.add(n.toLowerCase());
  }

  get isRunning(): boolean {
    return this.running;
  }

  get config(): BotConfig {
    return { ...this.cfg, huntedNames: this.huntedList };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.ac = new AbortController();

    // Cria o canal de notificacoes ja no start, mesmo antes do primeiro evento,
    // para os usuarios encontrarem a sala pronta.
    this.hub.ensureChannel(this.cfg.channelName);

    if (this.cfg.guildName) {
      await this.syncGuildMembers();
    }

    await this.deaths.poll(this.ac.signal);
    await this.online.poll(this.ac.signal);
    this.running = true;
    console.log(
      `[bot] ativo: world=${this.cfg.world}, hunted=${this.hunted.size}, ` +
        `canal="${this.cfg.channelName}", intervalo=${this.cfg.intervalMs / 1000}s`,
    );

    this.timer = setInterval(() => void this.tick(), this.cfg.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.running) return;
    this.ac.abort();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    console.log('[bot] parado');
  }

  async restart(newCfg: BotConfig): Promise<void> {
    this.stop();
    this.cfg = newCfg;
    this.deaths = new DeathTracker();
    this.online = new OnlineTracker(newCfg.world);
    this.hunted.clear();
    for (const n of newCfg.huntedNames) this.hunted.add(n.toLowerCase());
    this.pendingLogins.length = 0;
    this.pendingLogouts.length = 0;
    this.nextPresenceSummaryAt = 0;
    if (newCfg.enabled && newCfg.world) {
      await this.start();
    }
  }

  addHunted(name: string): void {
    this.hunted.add(name.toLowerCase());
  }

  removeHunted(name: string): void {
    this.hunted.delete(name.toLowerCase());
  }

  get huntedList(): string[] {
    return [...this.hunted];
  }

  // ---------------------------------------------------------------- poll --

  private async tick(): Promise<void> {
    try {
      const [deathEvents, onlineEvents] = await Promise.all([
        this.deaths.poll(this.ac.signal),
        this.online.poll(this.ac.signal),
      ]);

      for (const ev of deathEvents) this.onDeath(ev);
      for (const ev of onlineEvents) this.onOnline(ev);
      this.flushPresenceSummary(false);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      console.error('[bot] erro no poll:', err);
    }
  }

  // -------------------------------------------------------------- events --

  private isTracked(name: string): boolean {
    return this.hunted.has(name.toLowerCase());
  }

  private onDeath(ev: DeathEvent): void {
    if (ev.world !== this.cfg.world) return;

    const victimTracked = this.isTracked(ev.victim);
    const killerTracked = ev.killerIsPlayer && this.isTracked(ev.killedBy);

    if (!victimTracked && !killerTracked) return;

    let msg: string;
    if (victimTracked && ev.killerIsPlayer) {
      msg = `[death] ${ev.victim} (lvl ${ev.level}) morreu para ${ev.killedBy}`;
    } else if (victimTracked) {
      msg = `[death] ${ev.victim} (lvl ${ev.level}) morreu para ${ev.killedBy} (mob)`;
    } else {
      msg = `[kill] ${ev.killedBy} matou ${ev.victim} (lvl ${ev.level})`;
    }

    const global = msg.startsWith('[death]')
      ? this.cfg.globalDeaths
      : this.cfg.globalKills;
    this.post(msg, global);
  }

  private onOnline(ev: OnlineEvent): void {
    if (!this.isTracked(ev.player)) return;

    switch (ev.type) {
      case 'login':
        this.post(`[online] ${ev.player} logou (lvl ${ev.level}, ${ev.vocation ?? '?'})`, false);
        this.pendingLogins.push(ev);
        break;
      case 'logout':
        this.post(`[offline] ${ev.player} deslogou (lvl ${ev.level})`, false);
        this.pendingLogouts.push(ev);
        break;
      case 'levelup':
        this.post(
          `[levelup] ${ev.player} subiu de ${ev.previousLevel} para ${ev.level}`,
          this.cfg.globalLevelMin > 0 && ev.level >= this.cfg.globalLevelMin,
        );
        break;
    }
  }

  // ---------------------------------------------------------------- post --

  private post(text: string, global: boolean): void {
    const chId = this.hub.ensureChannel(this.cfg.channelName);
    this.hub.channelAnnounce(chId, 'rubinot', text);
    if (global) this.hub.serverChannelAnnounce(chId, 'rubinot', text);
    console.log(`[bot] ${text}`);
  }

  private flushPresenceSummary(force: boolean): void {
    if (!this.cfg.summarizePresence) {
      this.pendingLogins.length = 0;
      this.pendingLogouts.length = 0;
      return;
    }

    const now = Date.now();
    if (this.nextPresenceSummaryAt === 0) {
      this.nextPresenceSummaryAt = now + this.cfg.presenceSummaryMs;
    }
    if (!force && now < this.nextPresenceSummaryAt) return;
    if (this.pendingLogins.length === 0 && this.pendingLogouts.length === 0) {
      this.nextPresenceSummaryAt = now + this.cfg.presenceSummaryMs;
      return;
    }

    const parts: string[] = [];
    if (this.pendingLogins.length > 0) {
      parts.push(`${this.pendingLogins.length} entraram: ${names(this.pendingLogins)}`);
    }
    if (this.pendingLogouts.length > 0) {
      parts.push(`${this.pendingLogouts.length} sairam: ${names(this.pendingLogouts)}`);
    }

    this.pendingLogins.length = 0;
    this.pendingLogouts.length = 0;
    this.nextPresenceSummaryAt = now + this.cfg.presenceSummaryMs;
    this.post(`[presence] ${parts.join(' | ')}`, true);
  }

  // ------------------------------------------------------------ guild sync --

  private async syncGuildMembers(): Promise<void> {
    try {
      const guild = await fetchGuild(this.cfg.guildName, this.ac.signal);
      let added = 0;
      for (const m of guild.members) {
        const key = m.name.toLowerCase();
        if (!this.hunted.has(key)) {
          this.hunted.add(key);
          added++;
        }
      }
      console.log(
        `[bot] guild "${this.cfg.guildName}": ${guild.members.length} membros, ${added} novos na hunted list`,
      );
    } catch (err) {
      console.error(`[bot] falha ao carregar guild "${this.cfg.guildName}":`, err);
    }
  }
}

function names(events: OnlineEvent[]): string {
  const list = events.slice(0, 8).map((ev) => ev.player);
  const extra = events.length - list.length;
  return extra > 0 ? `${list.join(', ')} +${extra}` : list.join(', ');
}
