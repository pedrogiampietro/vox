/**
 * Cliente tipado para a API JSON do Rubinot (rubinot.com.br).
 *
 * Endpoints publicos descobertos:
 *   GET /api/deaths?page=N              mortes recentes (todas as worlds)
 *   GET /api/worlds                     lista de worlds com contagem online
 *   GET /api/worlds/:name               jogadores online de uma world
 *   GET /api/guilds?page=N&worldId=N    guilds paginadas (worldId numerico)
 *   GET /api/guilds/:name               detalhe da guild com membros
 *
 * Cloudflare bloqueia o `fetch` do Node pelo TLS fingerprint (JA3), entao usamos
 * cycletls, que impersona o handshake do Chrome.
 */

import initCycleTLS, { type CycleTLSClient } from 'cycletls';

const BASE = 'https://rubinot.com.br';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// JA3 do Chrome 124+ - o que o Cloudflare aceita como "browser real".
const JA3 =
  '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513-21,29-23-24,0';

let clientPromise: Promise<CycleTLSClient> | null = null;
function getClient(): Promise<CycleTLSClient> {
  clientPromise ??= initCycleTLS();
  return clientPromise;
}

export async function shutdownRubinotClient(): Promise<void> {
  if (!clientPromise) return;
  const c = await clientPromise;
  await c.exit();
  clientPromise = null;
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
