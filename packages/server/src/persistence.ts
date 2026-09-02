/** Persistencia permanente dos servidores em SQLite, com export JSON legivel. */
import { readFileSync } from 'node:fs';
import { ChannelFlags, DEFAULT_GROUP_DEFS, Group } from '@vox/protocol';
import type { ChannelInfo, GroupDef } from '@vox/protocol';
import { config } from './config.js';
import { database, exportJson } from './sqlite.js';

export interface StoredChannel extends ChannelInfo { password: string; }
export interface StoredBan { fingerprint: string; until: number; reason: string; }
export interface StoredRespClaim {
  id: number;
  respawn: string;
  note: string;
  ownerName: string;
  ownerFingerprint: string;
  claimedAt: number;
  expiresAt: number;
}
export interface StoredBotConfig {
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

export interface StoredServer {
  id: number; slug: string; ownerId: number | null; name: string; motd: string;
  password: string; maxClients: number; channels: StoredChannel[];
  groups: Record<string, Group>; bans: StoredBan[]; groupDefs: GroupDef[];
  claims: StoredRespClaim[];
  botConfig: StoredBotConfig;
}

export function defaultChannels(): StoredChannel[] {
  return [
    { id: 1, parentId: 0, order: 0, name: 'Lobby', topic: 'Canal de entrada', maxClients: 0, flags: ChannelFlags.Default | ChannelFlags.Permanent, password: '' },
    { id: 2, parentId: 0, order: 1, name: 'Sala 1', topic: '', maxClients: 0, flags: ChannelFlags.Permanent, password: '' },
    { id: 3, parentId: 0, order: 2, name: 'Sala 2', topic: '', maxClients: 0, flags: ChannelFlags.Permanent, password: '' },
  ];
}

export const DEFAULT_BOT_CONFIG: StoredBotConfig = {
  world: '',
  guildName: '',
  huntedNames: [],
  intervalMs: 60_000,
  channelName: 'bot',
  enabled: false,
  globalDeaths: true,
  globalKills: true,
  globalLevelMin: 800,
  summarizePresence: true,
  presenceSummaryMs: 5 * 60_000,
};

export function defaultServer(id = 1): StoredServer {
  return { id, slug: `server-${id}`, ownerId: null, name: config.serverName, motd: config.motd, password: config.password, maxClients: config.maxClients, channels: defaultChannels(), groups: {}, bans: [], groupDefs: [...DEFAULT_GROUP_DEFS], claims: [], botConfig: { ...DEFAULT_BOT_CONFIG } };
}

export function loadServers(): StoredServer[] {
  const count = Number(database.prepare('SELECT COUNT(*) AS count FROM servers').get()?.count ?? 0);
  if (count === 0) {
    const servers = readJsonServers();
    const initial = servers.length > 0 ? servers : [defaultServer()];
    saveServers(initial);
    return initial;
  }
  return database.prepare('SELECT * FROM servers ORDER BY id').all().map(fromRow);
}

export function saveServers(servers: StoredServer[]): void {
  const insert = database.prepare('INSERT INTO servers (id, slug, owner_id, name, motd, password, max_clients, channels_json, groups_json, bans_json, group_defs_json, claims_json, bot_config_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  database.exec('BEGIN');
  try {
    database.exec('DELETE FROM servers');
    for (const s of servers) insert.run(s.id, s.slug, s.ownerId, s.name, s.motd, s.password, s.maxClients, JSON.stringify(s.channels), JSON.stringify(s.groups), JSON.stringify(s.bans), JSON.stringify(s.groupDefs), JSON.stringify(s.claims), JSON.stringify(s.botConfig));
    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
  exportJson('servers.json', servers);
}

function readJsonServers(): StoredServer[] {
  try {
    const parsed = JSON.parse(readFileSync(`${config.dataDir}/servers.json`, 'utf8')) as Partial<StoredServer>[];
    if (Array.isArray(parsed) && parsed.length > 0) return parsed.map(normalize);
  } catch { /* migracao inicial */ }
  try {
    const channels = JSON.parse(readFileSync(`${config.dataDir}/channels.json`, 'utf8')) as StoredChannel[];
    if (Array.isArray(channels) && channels.length > 0) {
      const server = defaultServer();
      server.channels = channels;
      return [server];
    }
  } catch { /* sem legado */ }
  return [];
}

function normalizeBotConfig(raw: unknown): StoredBotConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_BOT_CONFIG };
  const c = raw as Record<string, unknown>;
  return {
    world: typeof c.world === 'string' ? c.world : '',
    guildName: typeof c.guildName === 'string' ? c.guildName : '',
    huntedNames: Array.isArray(c.huntedNames) ? (c.huntedNames as unknown[]).filter((n): n is string => typeof n === 'string') : [],
    intervalMs: typeof c.intervalMs === 'number' && c.intervalMs > 0 ? c.intervalMs : 60_000,
    channelName: typeof c.channelName === 'string' && c.channelName ? c.channelName : 'bot',
    enabled: typeof c.enabled === 'boolean' ? c.enabled : false,
    globalDeaths: typeof c.globalDeaths === 'boolean' ? c.globalDeaths : true,
    globalKills: typeof c.globalKills === 'boolean' ? c.globalKills : true,
    globalLevelMin: typeof c.globalLevelMin === 'number' && c.globalLevelMin >= 0 ? c.globalLevelMin : 800,
    summarizePresence: typeof c.summarizePresence === 'boolean' ? c.summarizePresence : true,
    presenceSummaryMs: typeof c.presenceSummaryMs === 'number' && c.presenceSummaryMs > 0
      ? c.presenceSummaryMs
      : 5 * 60_000,
  };
}

function normalize(s: Partial<StoredServer>): StoredServer {
  const base = defaultServer(s.id ?? 1);
  return { ...base, ...s, id: s.id ?? base.id, slug: normalizeSlug(s.slug) || `server-${s.id ?? base.id}`, ownerId: typeof s.ownerId === 'number' ? s.ownerId : null, channels: s.channels?.length ? s.channels : base.channels, groups: s.groups ?? {}, bans: s.bans ?? [], groupDefs: s.groupDefs?.length ? s.groupDefs : [...DEFAULT_GROUP_DEFS], claims: normalizeClaims(s.claims), botConfig: normalizeBotConfig(s.botConfig) };
}

function fromRow(row: Record<string, unknown>): StoredServer {
  return normalize({ id: Number(row.id), slug: String(row.slug), ownerId: row.owner_id === null ? null : Number(row.owner_id), name: String(row.name), motd: String(row.motd), password: String(row.password), maxClients: Number(row.max_clients), channels: JSON.parse(String(row.channels_json)), groups: JSON.parse(String(row.groups_json)), bans: JSON.parse(String(row.bans_json)), groupDefs: JSON.parse(String(row.group_defs_json)), claims: JSON.parse(String(row.claims_json || '[]')), botConfig: JSON.parse(String(row.bot_config_json || '{}')) });
}

function normalizeClaims(raw: unknown): StoredRespClaim[] {
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  return raw
    .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object')
    .map((c) => ({
      id: Number(c.id) || 0,
      respawn: typeof c.respawn === 'string' ? c.respawn : '',
      note: typeof c.note === 'string' ? c.note : '',
      ownerName: typeof c.ownerName === 'string' ? c.ownerName : '',
      ownerFingerprint: typeof c.ownerFingerprint === 'string' ? c.ownerFingerprint : '',
      claimedAt: Number(c.claimedAt) || now,
      expiresAt: Number(c.expiresAt) || 0,
    }))
    .filter((c) => c.id > 0 && c.respawn && c.expiresAt > now);
}

function normalizeSlug(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(value) ? value : '';
}
