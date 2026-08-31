/**
 * Persistencia dos canais permanentes.
 *
 * Um arquivo JSON e o bastante: sao dezenas de canais, escritos raramente.
 * Banco de dados aqui seria peso morto - canais temporarios e usuarios online
 * vivem so em memoria de qualquer jeito.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChannelFlags } from '@vox/protocol';
import type { ChannelInfo } from '@vox/protocol';
import { config } from './config.js';

interface StoredChannel extends ChannelInfo {
  password: string;
}

const FILE = () => join(config.dataDir, 'channels.json');

const DEFAULTS: StoredChannel[] = [
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

export function loadChannels(): StoredChannel[] {
  try {
    const raw = readFileSync(FILE(), 'utf8');
    const parsed = JSON.parse(raw) as StoredChannel[];
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    // Primeira execucao ou arquivo corrompido: cai nos padroes.
  }
  return DEFAULTS;
}

export function saveChannels(channels: StoredChannel[]): void {
  try {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(FILE(), JSON.stringify(channels, null, 2));
  } catch (err) {
    console.error('[vox] falha ao gravar canais:', err);
  }
}
