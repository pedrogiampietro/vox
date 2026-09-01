/**
 * Persistencia: um arquivo JSON com todos os servidores virtuais.
 *
 * Sao dezenas de canais e um punhado de servidores, escritos raramente. Banco
 * de dados aqui seria peso morto - canais temporarios e quem esta online vivem
 * so em memoria de qualquer jeito.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChannelFlags, DEFAULT_GROUP_DEFS, Group } from '@vox/protocol';
import type { ChannelInfo, GroupDef } from '@vox/protocol';
import { config } from './config.js';

export interface StoredChannel extends ChannelInfo {
  password: string;
}

export interface StoredBan {
  fingerprint: string;
  /** Epoch em ms; 0 = permanente. */
  until: number;
  reason: string;
}

export interface StoredServer {
  id: number;
  name: string;
  motd: string;
  password: string;
  maxClients: number;
  channels: StoredChannel[];
  /** Impressao digital -> grupo. Quem nao esta aqui e convidado. */
  groups: Record<string, Group>;
  bans: StoredBan[];
  /** Definicoes visuais dos grupos (nome, icone, cor). */
  groupDefs: GroupDef[];
}

const FILE = (): string => join(config.dataDir, 'servers.json');
/** Formato anterior, de quando havia um servidor so. */
const LEGACY_FILE = (): string => join(config.dataDir, 'channels.json');

export function defaultChannels(): StoredChannel[] {
  return [
    {
      id: 1,
      parentId: 0,
      order: 0,
      name: 'Lobby',
      topic: 'Canal de entrada',
      maxClients: 0,
      flags: ChannelFlags.Default | ChannelFlags.Permanent,
      password: '',
    },
    {
      id: 2,
      parentId: 0,
      order: 1,
      name: 'Sala 1',
      topic: '',
      maxClients: 0,
      flags: ChannelFlags.Permanent,
      password: '',
    },
    {
      id: 3,
      parentId: 0,
      order: 2,
      name: 'Sala 2',
      topic: '',
      maxClients: 0,
      flags: ChannelFlags.Permanent,
      password: '',
    },
  ];
}

export function defaultServer(id = 1): StoredServer {
  return {
    id,
    name: config.serverName,
    motd: config.motd,
    password: config.password,
    maxClients: config.maxClients,
    channels: defaultChannels(),
    groups: {},
    bans: [],
    groupDefs: [...DEFAULT_GROUP_DEFS],
  };
}

export function loadServers(): StoredServer[] {
  try {
    const parsed = JSON.parse(readFileSync(FILE(), 'utf8')) as StoredServer[];
    if (Array.isArray(parsed) && parsed.length > 0) return parsed.map(normalize);
  } catch {
    // sem arquivo ainda, ou corrompido: tenta o formato antigo abaixo
  }

  // Migracao: quem ja rodava a versao de um servidor so nao perde os canais.
  try {
    const channels = JSON.parse(readFileSync(LEGACY_FILE(), 'utf8')) as StoredChannel[];
    if (Array.isArray(channels) && channels.length > 0) {
      console.log('[vox] migrando channels.json para o formato de servidores virtuais');
      const server = defaultServer();
      server.channels = channels;
      saveServers([server]);
      return [server];
    }
  } catch {
    // primeira execucao mesmo
  }

  return [defaultServer()];
}

/** Preenche campos que versoes antigas do arquivo nao tinham. */
function normalize(s: Partial<StoredServer>): StoredServer {
  const base = defaultServer(s.id ?? 1);
  return {
    ...base,
    ...s,
    id: s.id ?? base.id,
    channels: s.channels?.length ? s.channels : base.channels,
    groups: s.groups ?? {},
    bans: s.bans ?? [],
    groupDefs: s.groupDefs?.length ? s.groupDefs : [...DEFAULT_GROUP_DEFS],
  };
}

/**
 * Grava por arquivo temporario e renomeia. Sem isso, uma queda no meio da
 * escrita deixaria o JSON pela metade e o servidor voltaria sem nada.
 */
export function saveServers(servers: StoredServer[]): void {
  try {
    mkdirSync(config.dataDir, { recursive: true });
    const tmp = `${FILE()}.tmp`;
    writeFileSync(tmp, JSON.stringify(servers, null, 2));
    renameSync(tmp, FILE());
  } catch (err) {
    console.error('[vox] falha ao gravar os servidores:', err);
  }
}
