/**
 * Cliente tipado para a API JSON do Rubinot (rubinot.com.br).
 *
 * Endpoints publicos descobertos:
 *   GET /api/deaths?page=N              mortes recentes (todas as worlds)
 *   GET /api/worlds                     lista de worlds com contagem online
 *   GET /api/worlds/:name               jogadores online de uma world
 *   GET /api/guilds?page=N&worldId=N    guilds paginadas (worldId numerico)
 *   GET /api/guilds/:name               detalhe da guild com membros
 *   GET /api/transfers?toWorld=ID&page=N transfers recentes para uma world
 *   GET /api/characters/search?name=...  ficha e antigos nomes do personagem
 *
 * Cloudflare bloqueia o `fetch` do Node pelo TLS fingerprint (JA3), entao usamos
 * cycletls, que impersona o handshake do Chrome.
 */

import initCycleTLS, { type CycleTLSClient } from 'cycletls';
import { epochToMs, normalizeVocation, normalizeVocationNumber, type GameProvider, type ProviderTransfer } from './provider.js';

const BASE = 'https://rubinot.com.br';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// JA3 do Chrome 124+ - o que o Cloudflare aceita como "browser real".
const JA3 =
  '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513-21,29-23-24,0';

let clientPromise: Promise<CycleTLSClient> | null = null;
let transferWorldIdsPromise: Promise<Map<string, number>> | null = null;
function getClient(): Promise<CycleTLSClient> {
  clientPromise ??= initCycleTLS();
  return clientPromise;
}

export async function shutdownRubinotClient(): Promise<void> {
  if (!clientPromise) return;
  const c = await clientPromise;
  await c.exit();
  clientPromise = null;
  transferWorldIdsPromise = null;
}

// ----------------------------------------------------------------- tipos --

export interface RubinotDeath {
  time: string;
  level: number;
  killed_by: string;
  is_player: number;
  mostdamage_by: string;
  mostdamage_is_player: number;
  victim: string;
  worldName: string;
}

export interface RubinotWorld {
  name: string;
  pvpType: string;
  pvpTypeLabel: string;
  worldType: string;
  locked: boolean;
  creationDate: number;
  playersOnline: number;
}

export interface RubinotOnlinePlayer {
  name: string;
  level: number;
  vocation: string;
}

export interface RubinotWorldDetail {
  world: RubinotWorld;
  playersOnline: number;
  record: number;
  recordTime: number;
  players: RubinotOnlinePlayer[];
}

export interface RubinotTransfer {
  player_name: string;
  player_level: number;
  from_world: string;
  to_world: string;
  transferred_at: number;
}

export interface RubinotGuildSummary {
  name: string;
  description: string;
}

export interface RubinotGuildMember {
  name: string;
  level: number;
  vocation: number;
  rank: string;
  rankLevel: number;
  nick: string;
  joinDate: number;
  isOnline: boolean;
}

export interface RubinotGuild {
  name: string;
  motd: string;
  description: string;
  homepage: string;
  worldName: string;
  logo_name: string;
  balance: number;
  creationdata: number;
  owner: string;
  members: RubinotGuildMember[];
  ranks: { id: number; name: string; level: number }[];
  residence: string;
}

// --------------------------------------------------------------- paginado --

interface Paginated<T> {
  data: T[];
  totalCount: number;
  totalPages: number;
  currentPage: number;
}

// ----------------------------------------------------------------- fetch --

async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const client = await getClient();
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  const res = await client.get(`${BASE}${path}`, {
    ja3: JA3,
    userAgent: UA,
    headers: {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      referer: `${BASE}/`,
      'sec-ch-ua': '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    },
    timeout: 15,
  });
  if (res.status < 200 || res.status >= 300) {
    const preview = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    throw new Error(`Rubinot ${res.status} em ${path}: ${preview.slice(0, 200)}`);
  }
  // cycletls ja parsea JSON quando o content-type indica; se veio string, parseia.
  return (typeof res.body === 'string' ? JSON.parse(res.body) : res.body) as T;
}

// ------------------------------------------------------------- endpoints --

export async function fetchDeaths(
  page = 1,
  signal?: AbortSignal,
): Promise<Paginated<RubinotDeath>> {
  const raw = await api<{
    deaths: RubinotDeath[];
    totalCount: number;
    totalPages: number;
    currentPage: number;
  }>(`/api/deaths?page=${page}`, signal);
  return {
    data: raw.deaths,
    totalCount: raw.totalCount,
    totalPages: raw.totalPages,
    currentPage: raw.currentPage,
  };
}

export async function fetchWorlds(signal?: AbortSignal): Promise<RubinotWorld[]> {
  const raw = await api<{ worlds: RubinotWorld[] }>('/api/worlds', signal);
  return raw.worlds;
}

export async function fetchWorldOnline(
  worldName: string,
  signal?: AbortSignal,
): Promise<RubinotWorldDetail> {
  return api<RubinotWorldDetail>(`/api/worlds/${encodeURIComponent(worldName)}`, signal);
}

export async function fetchGuilds(
  page = 1,
  worldId?: number,
  signal?: AbortSignal,
): Promise<Paginated<RubinotGuildSummary>> {
  let url = `/api/guilds?page=${page}`;
  if (worldId !== undefined) url += `&worldId=${worldId}`;
  const raw = await api<{
    guilds: RubinotGuildSummary[];
    totalCount: number;
    totalPages: number;
    currentPage: number;
  }>(url, signal);
  return {
    data: raw.guilds,
    totalCount: raw.totalCount,
    totalPages: raw.totalPages,
    currentPage: raw.currentPage,
  };
}

export async function fetchGuild(
  name: string,
  signal?: AbortSignal,
): Promise<RubinotGuild> {
  const raw = await api<{ guild: RubinotGuild }>(
    `/api/guilds/${encodeURIComponent(name)}`,
    signal,
  );
  return raw.guild;
}

export async function fetchTransfers(
  toWorldId: number,
  page = 1,
  signal?: AbortSignal,
): Promise<Paginated<RubinotTransfer>> {
  const raw = await api<{
    transfers: RubinotTransfer[];
    totalResults: number;
    totalPages: number;
    currentPage: number;
  }>(`/api/transfers?toWorld=${toWorldId}&page=${page}`, signal);
  return {
    data: raw.transfers,
    totalCount: raw.totalResults,
    totalPages: raw.totalPages,
    currentPage: raw.currentPage,
  };
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim();
}

async function fetchTransferWorldIds(signal?: AbortSignal): Promise<Map<string, number>> {
  const client = await getClient();
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  const res = await client.get(`${BASE}/transfers`, {
    ja3: JA3,
    userAgent: UA,
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      referer: `${BASE}/`,
    },
    timeout: 15,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Rubinot ${res.status} ao carregar a lista de worlds de transfers`);
  }
  const html = typeof res.body === 'string' ? res.body : String(res.body);
  const ids = new Map<string, number>();
  const optionRe = /<option\b[^>]*\bvalue=["'](\d+)["'][^>]*>([^<]+)<\/option>/gi;
  for (const match of html.matchAll(optionRe)) {
    const id = Number(match[1]);
    const world = decodeHtml(match[2] ?? '');
    if (Number.isInteger(id) && world) ids.set(world.toLowerCase(), id);
  }
  if (ids.size === 0) throw new Error('Rubinot não publicou os IDs dos worlds na página de transfers');
  return ids;
}

async function transferWorldId(world: string, signal?: AbortSignal): Promise<number> {
  transferWorldIdsPromise ??= fetchTransferWorldIds(signal);
  let ids: Map<string, number>;
  try {
    ids = await transferWorldIdsPromise;
  } catch (error) {
    // Nao deixa uma falha transitoria de rede transformar o cache em uma
    // Promise rejeitada permanente durante toda a vida do processo.
    transferWorldIdsPromise = null;
    throw error;
  }
  const id = ids.get(world.trim().toLowerCase());
  if (id === undefined) throw new Error(`world "${world}" não encontrado na lista de transfers do Rubinot`);
  return id;
}

export interface RubinotCharacter {
  name: string;
  level: number;
  vocation: string;
  world: string;
  online: boolean;
  formerNames?: string[];
}

/**
 * Consulta a ficha publica pelo endpoint JSON usado pelo frontend do Rubinot.
 * Retorna null se a ficha nao existe ou nao foi possivel extrair dados minimos.
 */
export async function fetchCharacter(
  name: string,
  signal?: AbortSignal,
): Promise<RubinotCharacter | null> {
  const raw = await api<{
    player?: {
      name?: string;
      level?: number;
      vocation?: string | number;
      world?: string;
      formerNames?: string[];
    };
    otherCharacters?: { name?: string; isOnline?: boolean }[];
  }>(`/api/characters/search?name=${encodeURIComponent(name)}`, signal);
  const player = raw.player;
  if (!player) return null;
  const level = Number(player.level) || 0;
  const vocation = typeof player.vocation === 'number'
    ? normalizeVocationNumber(player.vocation)
    : String(player.vocation ?? '');
  if (!level && !vocation) return null;
  const formerNames = (player.formerNames ?? []).map((oldName) => oldName.trim()).filter(Boolean);
  const online = (raw.otherCharacters ?? []).some(
    (other) => other.name?.toLowerCase() === player.name?.toLowerCase() && other.isOnline === true,
  );
  console.log(`[rubinot] fetchCharacter "${name}" -> lvl=${level} voc="${vocation}" world="${player.world ?? ''}" formerNames=${formerNames.length}`);
  return {
    name: player.name?.trim() || name,
    level,
    vocation,
    world: player.world?.trim() || '',
    online,
    formerNames,
  };
}

// --------------------------------------------------------------- provider --

/**
 * Adaptador pro contrato comum do bot. A API do Rubinot ja entrega tudo em
 * JSON, entao aqui so traduzimos nomes de campo e normalizamos a vocation —
 * que vem como numero no roster da guild e como texto na lista de online.
 */
export const rubinotProvider: GameProvider = {
  id: 'rubinot',
  label: 'Rubinot',

  async fetchWorldOnline(world, signal) {
    const detail = await fetchWorldOnline(world, signal);
    return detail.players.map((p) => ({
      name: p.name,
      level: p.level,
      vocation: normalizeVocation(p.vocation),
    }));
  },

  // A API nao filtra por world; quem consome ja descarta o que nao interessa.
  async fetchDeaths(_world, signal) {
    const page = await fetchDeaths(1, signal);
    return page.data.map((d) => ({
      victim: d.victim,
      level: d.level,
      killedBy: d.killed_by,
      killerIsPlayer: d.is_player === 1,
      world: d.worldName,
      timestamp: epochToMs(Number(d.time)),
    }));
  },

  async fetchGuild(name, signal) {
    const guild = await fetchGuild(name, signal);
    if (!guild) return null;
    return {
      name: guild.name,
      members: guild.members.map((m) => ({
        name: m.name,
        level: m.level,
        vocation: normalizeVocationNumber(m.vocation),
        isOnline: m.isOnline,
      })),
    };
  },

  async fetchCharacter(name, signal) {
    const char = await fetchCharacter(name, signal);
    if (!char) return null;
    return { ...char, vocation: normalizeVocation(char.vocation) };
  },

  async fetchTransfers(world, signal): Promise<ProviderTransfer[]> {
    const worldId = await transferWorldId(world, signal);
    const page = await fetchTransfers(worldId, 1, signal);
    const normalizedWorld = world.trim().toLowerCase();
    return page.data
      .filter((transfer) => transfer.to_world.trim().toLowerCase() === normalizedWorld)
      .filter((transfer) => Number(transfer.player_level) >= 300)
      .map((transfer) => ({
        player: transfer.player_name,
        level: Number(transfer.player_level) || 0,
        fromWorld: transfer.from_world,
        toWorld: transfer.to_world,
        transferredAt: epochToMs(Number(transfer.transferred_at)),
      }));
  },

  close: shutdownRubinotClient,
};
