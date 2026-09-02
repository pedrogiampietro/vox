/**
 * O conjunto de servidores virtuais.
 *
 * Um processo hospeda varios servidores independentes - canais, usuarios e
 * grupos proprios - mas todos na mesma porta. O TS3 usa uma porta UDP por
 * servidor; aqui o servidor virtual e escolhido no caminho do WebSocket
 * (`/vox/3`), o que mantem um certificado so, uma regra de firewall so, e uma
 * origem so para o navegador.
 *
 * O canal de voz por QUIC continua unico: o segredo de 16 bytes do Welcome ja
 * diz de qual sessao - e portanto de qual servidor - o datagrama veio.
 */

import { Group } from '@vox/protocol';
import { Hub, type ServerSettings } from './hub.js';
import { loadServers, saveServers, defaultChannels, type StoredServer } from './persistence.js';
import type { Session, VoiceSink } from './session.js';
import { clean, clamp } from './util.js';
import { config } from './config.js';

/** Gravacao adiada: uma rajada de mudancas vira uma escrita so. */
const SAVE_DEBOUNCE_MS = 2000;

export class Registry {
  private readonly hubs = new Map<number, Hub>();
  /** Segredo de voz -> sessao, atravessando todos os servidores virtuais. */
  private readonly byVoiceKey = new Map<string, Session>();

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private nextServerId = 1;

  voiceEndpoint: { port: number; certHash: Uint8Array } = {
    port: 0,
    certHash: new Uint8Array(0),
  };

  constructor() {
    for (const stored of loadServers()) this.attach(stored);
  }

  private attach(stored: StoredServer): Hub {
    const settings: ServerSettings = {
      id: stored.id,
      slug: stored.slug,
      ownerId: stored.ownerId,
      name: stored.name,
      motd: stored.motd,
      password: stored.password,
      maxClients: stored.maxClients,
      adminPassword: config.adminPassword,
    };
    const hub = new Hub(settings, stored, {
      onChanged: () => this.scheduleSave(),
      claimVoiceKey: (key, session) => this.byVoiceKey.set(key, session),
      releaseVoiceKey: (key) => this.byVoiceKey.delete(key),
      voiceEndpoint: () => this.voiceEndpoint,
    });
    this.hubs.set(stored.id, hub);
    if (stored.id >= this.nextServerId) this.nextServerId = stored.id + 1;
    return hub;
  }

  // ------------------------------------------------------------ consulta --

  list(): Hub[] {
    return [...this.hubs.values()].sort((a, b) => a.id - b.id);
  }

  get(id: number): Hub | undefined {
    return this.hubs.get(id);
  }

  getBySlug(slug: string): Hub | undefined {
    return this.list().find((hub) => hub.settings.slug === slug);
  }

  getByHost(host: string): Hub | undefined {
    const hostname = host.split(':')[0]?.toLowerCase() ?? '';
    const suffix = `.${config.baseDomain.toLowerCase()}`;
    if (!hostname.endsWith(suffix)) return undefined;
    const slug = hostname.slice(0, -suffix.length);
    return slug && !slug.includes('.') ? this.getBySlug(slug) : undefined;
  }

  /** Servidor usado quando o cliente conecta em `/vox` sem indicar qual. */
  primary(): Hub | undefined {
    return this.list()[0];
  }

  get totalClients(): number {
    let total = 0;
    for (const hub of this.hubs.values()) total += hub.clientCount;
    return total;
  }

  // ------------------------------------------------------------- gestao --

  create(input: Partial<ServerSettings>): Hub {
    const id = input.id && !this.hubs.has(input.id) ? input.id : this.nextServerId++;
    const requestedSlug = clean(input.slug ?? '', 32).toLowerCase();
    const slug = this.uniqueSlug(requestedSlug || slugify(input.name ?? `server-${id}`), id);
    const stored: StoredServer = {
      id,
      slug,
      ownerId: input.ownerId ?? null,
      name: clean(input.name ?? '', 64) || `Servidor ${id}`,
      motd: clean(input.motd ?? '', 256),
      password: input.password ?? '',
      maxClients: clamp(input.maxClients ?? 128, 1, 4096),
      channels: defaultChannels(),
      groups: {},
      bans: [],
      groupDefs: [],
    };
    const hub = this.attach(stored);
    this.scheduleSave();
    return hub;
  }

  update(id: number, input: Partial<ServerSettings>): Hub | null {
    const hub = this.hubs.get(id);
    if (!hub) return null;
    if (input.slug !== undefined && input.slug !== hub.settings.slug) {
      const slug = clean(input.slug, 32).toLowerCase();
      if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(slug) || this.getBySlug(slug)) return null;
      hub.settings.slug = slug;
    }
    if (input.name !== undefined) hub.settings.name = clean(input.name, 64) || hub.settings.name;
    if (input.motd !== undefined) hub.settings.motd = clean(input.motd, 256);
    if (input.password !== undefined) hub.settings.password = input.password;
    if (input.maxClients !== undefined) {
      hub.settings.maxClients = clamp(input.maxClients, 1, 4096);
    }
    this.scheduleSave();
    return hub;
  }

  private uniqueSlug(requested: string, id: number): string {
    const base = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(requested) ? requested : `server-${id}`;
    if (!this.getBySlug(base)) return base;
    for (let n = 2; n < 10_000; n++) {
      const candidate = `${base.slice(0, 26)}-${n}`;
      if (!this.getBySlug(candidate)) return candidate;
    }
    return `server-${id}`;
  }

  remove(id: number): boolean {
    const hub = this.hubs.get(id);
    if (!hub) return false;
    // Nunca deixar o processo sem nenhum servidor: ninguem conseguiria entrar
    // para criar outro.
    if (this.hubs.size === 1) return false;
    hub.shutdown('servidor removido');
    this.hubs.delete(id);
    this.scheduleSave();
    return true;
  }

  // ---------------------------------------------------------------- voz --

  /**
   * Liga um canal de voz recem-aberto a sessao dona do segredo.
   *
   * O segredo e a unica prova: a sessao de voz chega por outro socket, outra
   * porta e as vezes outro IP (NAT), entao nada mais serve para identifica-la.
   */
  bindVoice(token: Uint8Array, sink: VoiceSink): Session | null {
    const key = Buffer.from(token).toString('hex');
    const session = this.byVoiceKey.get(key);
    if (!session || !session.live) return null;
    session.voice?.close();
    session.voice = sink;
    return session;
  }

  /** Encontra o Hub de uma sessao, para o transporte de voz entregar o frame. */
  hubOf(session: Session): Hub | undefined {
    return this.hubs.get(session.serverId);
  }

  // ------------------------------------------------------------ rotina --

  sweep(now: number): void {
    for (const hub of this.hubs.values()) hub.sweep(now);
  }

  scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref();
  }

  saveNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    saveServers(this.list().map((h) => h.toStored()));
  }

  /** Resumo para o painel e para o /health. */
  snapshot(): {
    id: number;
    slug: string;
    ownerId: number | null;
    name: string;
    motd: string;
    clients: number;
    maxClients: number;
    channels: number;
    protected: boolean;
    admins: number;
  }[] {
    return this.list().map((hub) => ({
      id: hub.id,
      slug: hub.settings.slug,
      ownerId: hub.settings.ownerId,
      name: hub.settings.name,
      motd: hub.settings.motd,
      clients: hub.clientCount,
      maxClients: hub.settings.maxClients,
      channels: hub.channelList.length,
      protected: hub.settings.password !== '',
      admins: Object.values(hub.groupList()).filter((g) => g >= Group.Admin).length,
    }));
  }
}

function slugify(value: string): string {
  const slug = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return slug || 'server';
}
