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
  /** Legado: mantido por compatibilidade, mas friendGuilds e a fonte. */
  guildName: string;
  huntedNames: string[];
  friendGuilds: string[];
  enemyGuilds: string[];
  intervalMs: number;
  channelName: string;
  enabled: boolean;
  globalDeaths: boolean;
  globalKills: boolean;
  globalLevelMin: number;
  summarizePresence: boolean;
  presenceSummaryMs: number;
  alertEnemyDeath: boolean;
  alertFriendDeath: boolean;
  alertFriendLevelUp: boolean;
  alertEnemyLevelUp: boolean;
  alertEnemyOnline: boolean;
  alertEnemyOffline: boolean;
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
    friendGuilds: process.env['BOT_GUILD'] ? [process.env['BOT_GUILD']!] : [],
    enemyGuilds: (process.env['BOT_ENEMY_GUILDS'] ?? '')
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean),
    globalDeaths: true,
    globalKills: true,
    globalLevelMin: 800,
    summarizePresence: true,
    presenceSummaryMs: 5 * 60 * 1000,
    alertEnemyDeath: true,
    alertFriendDeath: true,
    alertFriendLevelUp: true,
    alertEnemyLevelUp: true,
    alertEnemyOnline: true,
    alertEnemyOffline: true,
  };
}

// ------------------------------------------------------------------- bot --

interface PlayerTag {
  kind: 'friend' | 'enemy';
  /** Guild que classificou este jogador. Vazio para hunted manual. */
  guild: string;
}

export class RubinotBot {
  private deaths = new DeathTracker();
  private online: OnlineTracker;
  /** Nome (lower) -> guild + kind. Fonte unica pra decidir amigo/inimigo/tag. */
  private readonly tags = new Map<string, PlayerTag>();
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
    this.seedManualEnemies();
  }

  private seedManualEnemies(): void {
    for (const n of this.cfg.huntedNames) {
      const key = n.toLowerCase();
      if (!this.tags.has(key)) this.tags.set(key, { kind: 'enemy', guild: '' });
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  get config(): BotConfig {
    return { ...this.cfg, huntedNames: this.huntedList };
  }

  get friendsList(): string[] {
    return [...this.tags.entries()].filter(([, t]) => t.kind === 'friend').map(([n]) => n);
  }

  get enemiesList(): string[] {
    return [...this.tags.entries()].filter(([, t]) => t.kind === 'enemy').map(([n]) => n);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.ac = new AbortController();

    // Cria o canal de notificacoes ja no start, mesmo antes do primeiro evento,
    // para os usuarios encontrarem a sala pronta.
    this.hub.ensureChannel(this.cfg.channelName);

    await this.syncAllGuilds();

    await this.deaths.poll(this.ac.signal);
    await this.online.poll(this.ac.signal);
    this.running = true;
    const enemies = this.enemiesList.length;
    const friends = this.friendsList.length;
    console.log(
      `[bot] ativo: world=${this.cfg.world}, inimigos=${enemies}, amigos=${friends}, ` +
        `guilds amigas=${this.cfg.friendGuilds.length}, inimigas=${this.cfg.enemyGuilds.length}, ` +
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
    this.tags.clear();
    this.seedManualEnemies();
    this.pendingLogins.length = 0;
    this.pendingLogouts.length = 0;
    this.nextPresenceSummaryAt = 0;
    if (newCfg.enabled && newCfg.world) {
      await this.start();
    }
  }

  addHunted(name: string): void {
    const key = name.toLowerCase();
    const existing = this.tags.get(key);
    // Nao rebaixa quem ja e amigo (via guild) para inimigo manual.
    if (existing?.kind === 'friend') return;
    this.tags.set(key, { kind: 'enemy', guild: '' });
  }

  removeHunted(name: string): void {
    const key = name.toLowerCase();
    const existing = this.tags.get(key);
    // Nome vindo de guild nao e removido pela lista manual.
    if (!existing || existing.guild) return;
    this.tags.delete(key);
  }

  /** Lista combinada, para clientes antigos e persistencia. */
  get huntedList(): string[] {
    return this.enemiesList;
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
      this.refreshPlayerInfos();
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      console.error('[bot] erro no poll:', err);
    }
  }

  /**
   * Percorre os "Main: <nome>" registrados via descricao dos usuarios e
   * atualiza voc/level/online usando o snapshot do OnlineTracker.
   */
  private refreshPlayerInfos(): void {
    const mains = this.hub.trackedMains();
    if (mains.size === 0) return;

    // Indice por nome-lower dos jogadores atualmente online (world do bot).
    const onlineByLower = new Map<string, { name: string; level: number; vocation: string }>();
    for (const [name, snap] of this.online.entries()) {
      onlineByLower.set(name.toLowerCase(), { name, ...snap });
    }

    for (const [nameLower] of mains) {
      const player = onlineByLower.get(nameLower);
      if (player) {
        this.hub.updatePlayerInfo(nameLower, {
          name: player.name,
          vocation: normalizeVocation(player.vocation),
          level: player.level,
          online: true,
        });
      } else {
        this.hub.updatePlayerInfo(nameLower, {
          name: nameLower,
          online: false,
        });
      }
    }
  }

  // -------------------------------------------------------------- events --

  private tagOf(name: string): PlayerTag | null {
    return this.tags.get(name.toLowerCase()) ?? null;
  }

  /** `[GUILDNAME]` (upper) quando o jogador veio de uma guild rastreada. */
  private guildFlag(tag: PlayerTag | null): string {
    return tag?.guild ? `[${tag.guild.toUpperCase()}]` : '';
  }

  private onDeath(ev: DeathEvent): void {
    if (ev.world !== this.cfg.world) return;

    const victim = this.tagOf(ev.victim);
    const killer = ev.killerIsPlayer ? this.tagOf(ev.killedBy) : null;

    if (!victim && !killer) return;

    // Cada linha pode ser sobre a morte da vitima ou sobre o kill do outro:
    // enviamos ate as duas mensagens quando ambos os lados estao rastreados,
    // respeitando o toggle de cada uma.
    if (victim) {
      const allow = victim.kind === 'friend' ? this.cfg.alertFriendDeath : this.cfg.alertEnemyDeath;
      if (allow) {
        const cause = ev.killerIsPlayer ? ev.killedBy : `${ev.killedBy} (mob)`;
        const label = victim.kind === 'friend' ? 'death/amigo' : 'death/inimigo';
        this.post(
          `[${label}]${this.guildFlag(victim)} ${ev.victim} (lvl ${ev.level}) morreu para ${cause}`,
          this.cfg.globalDeaths,
        );
      }
    }
    if (killer && !victim) {
      // Se a vitima ja gerou o post, evitar ruido dobrado: a linha ja cita o killer.
      const allow = killer.kind === 'friend' ? this.cfg.alertFriendDeath : this.cfg.alertEnemyDeath;
      if (allow) {
        const label = killer.kind === 'friend' ? 'kill/amigo' : 'kill/inimigo';
        this.post(
          `[${label}]${this.guildFlag(killer)} ${ev.killedBy} matou ${ev.victim} (lvl ${ev.level})`,
          this.cfg.globalKills,
        );
      }
    }
  }

  private onOnline(ev: OnlineEvent): void {
    const tag = this.tagOf(ev.player);
    if (!tag) return;
    const enemy = tag.kind === 'enemy';
    const friend = tag.kind === 'friend';
    const flag = this.guildFlag(tag);

    switch (ev.type) {
      case 'login':
        if (enemy && this.cfg.alertEnemyOnline) {
          this.post(`[online/inimigo]${flag} ${ev.player} logou (lvl ${ev.level}, ${ev.vocation ?? '?'})`, false);
        }
        if (enemy) this.pendingLogins.push(ev);
        break;
      case 'logout':
        if (enemy && this.cfg.alertEnemyOffline) {
          this.post(`[offline/inimigo]${flag} ${ev.player} deslogou (lvl ${ev.level})`, false);
        }
        if (enemy) this.pendingLogouts.push(ev);
        break;
      case 'levelup': {
        const allow = friend ? this.cfg.alertFriendLevelUp : this.cfg.alertEnemyLevelUp;
        if (!allow) return;
        const label = friend ? 'levelup/amigo' : 'levelup/inimigo';
        this.post(
          `[${label}]${flag} ${ev.player} subiu de ${ev.previousLevel} para ${ev.level}`,
          this.cfg.globalLevelMin > 0 && ev.level >= this.cfg.globalLevelMin,
        );
        break;
      }
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

  private async syncAllGuilds(): Promise<void> {
    // Remove tags de guild antes de recarregar; jogadores adicionados
    // manualmente (guild vazia) sobrevivem.
    for (const [key, tag] of this.tags) {
      if (tag.guild) this.tags.delete(key);
    }

    for (const g of this.cfg.friendGuilds) await this.syncGuild(g, 'friend');
    for (const g of this.cfg.enemyGuilds) await this.syncGuild(g, 'enemy');
  }

  private async syncGuild(name: string, kind: 'friend' | 'enemy'): Promise<void> {
    try {
      const guild = await fetchGuild(name, this.ac.signal);
      let added = 0;
      for (const m of guild.members) {
        const key = m.name.toLowerCase();
        // Amigo tem prioridade — mesmo nome em guild amiga e inimiga vira amigo.
        const existing = this.tags.get(key);
        if (existing?.kind === 'friend' && kind === 'enemy') continue;
        this.tags.set(key, { kind, guild: name });
        added++;
      }
      console.log(
        `[bot] guild ${kind} "${name}": ${guild.members.length} membros, ${added} classificados`,
      );
    } catch (err) {
      console.error(`[bot] falha ao carregar guild "${name}":`, err);
    }
  }
}

function names(events: OnlineEvent[]): string {
  const list = events.slice(0, 8).map((ev) => ev.player);
  const extra = events.length - list.length;
  return extra > 0 ? `${list.join(', ')} +${extra}` : list.join(', ');
}

/** Rubinot manda voc como "Elite Knight"/"Master Sorcerer"/etc. Curte pra EK/ED/MS/RP/MK. */
function normalizeVocation(v: string): string {
  const lower = v.toLowerCase();
  if (lower.includes('elite knight')) return 'EK';
  if (lower.includes('elder druid')) return 'ED';
  if (lower.includes('master sorcerer')) return 'MS';
  if (lower.includes('royal paladin')) return 'RP';
  if (lower.includes('monk')) return 'MK';
  // Vocacoes base (baixo level, sem promocao) mapeiam pro icone da promovida.
  if (lower.includes('knight')) return 'EK';
  if (lower.includes('druid')) return 'ED';
  if (lower.includes('sorcerer')) return 'MS';
  if (lower.includes('paladin')) return 'RP';
  return '';
}
