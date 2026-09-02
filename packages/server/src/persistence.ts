/** Persistencia permanente dos servidores em SQLite, com export JSON legivel. */
import { readFileSync } from 'node:fs';
import { ChannelFlags, DEFAULT_GROUP_DEFS, Group } from '@vox/protocol';
import type { ChannelInfo, GroupDef } from '@vox/protocol';
import { config } from './config.js';
import { database, exportJson } from './sqlite.js';

export interface StoredChannel extends ChannelInfo { password: string; }
export interface StoredBan { fingerprint: string; until: number; reason: string; }
export interface StoredServer {
  id: number; slug: string; ownerId: number | null; name: string; motd: string;
  password: string; maxClients: number; channels: StoredChannel[];
  groups: Record<string, Group>; bans: StoredBan[]; groupDefs: GroupDef[];
}

export function defaultChannels(): StoredChannel[] {
  return [
    { id: 1, parentId: 0, order: 0, name: 'Lobby', topic: 'Canal de entrada', maxClients: 0, flags: ChannelFlags.Default | ChannelFlags.Permanent, password: '' },
    { id: 2, parentId: 0, order: 1, name: 'Sala 1', topic: '', maxClients: 0, flags: ChannelFlags.Permanent, password: '' },
    { id: 3, parentId: 0, order: 2, name: 'Sala 2', topic: '', maxClients: 0, flags: ChannelFlags.Permanent, password: '' },
  ];
}

export function defaultServer(id = 1): StoredServer {
  return { id, slug: `server-${id}`, ownerId: null, name: config.serverName, motd: config.motd, password: config.password, maxClients: config.maxClients, channels: defaultChannels(), groups: {}, bans: [], groupDefs: [...DEFAULT_GROUP_DEFS] };
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
  const insert = database.prepare('INSERT INTO servers (id, slug, owner_id, name, motd, password, max_clients, channels_json, groups_json, bans_json, group_defs_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  database.exec('BEGIN');
  try {
    database.exec('DELETE FROM servers');
    for (const s of servers) insert.run(s.id, s.slug, s.ownerId, s.name, s.motd, s.password, s.maxClients, JSON.stringify(s.channels), JSON.stringify(s.groups), JSON.stringify(s.bans), JSON.stringify(s.groupDefs));
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

function normalize(s: Partial<StoredServer>): StoredServer {
  const base = defaultServer(s.id ?? 1);
  return { ...base, ...s, id: s.id ?? base.id, slug: normalizeSlug(s.slug) || `server-${s.id ?? base.id}`, ownerId: typeof s.ownerId === 'number' ? s.ownerId : null, channels: s.channels?.length ? s.channels : base.channels, groups: s.groups ?? {}, bans: s.bans ?? [], groupDefs: s.groupDefs?.length ? s.groupDefs : [...DEFAULT_GROUP_DEFS] };
}

function fromRow(row: Record<string, unknown>): StoredServer {
  return normalize({ id: Number(row.id), slug: String(row.slug), ownerId: row.owner_id === null ? null : Number(row.owner_id), name: String(row.name), motd: String(row.motd), password: String(row.password), maxClients: Number(row.max_clients), channels: JSON.parse(String(row.channels_json)), groups: JSON.parse(String(row.groups_json)), bans: JSON.parse(String(row.bans_json)), groupDefs: JSON.parse(String(row.group_defs_json)) });
}

function normalizeSlug(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(value) ? value : '';
}
