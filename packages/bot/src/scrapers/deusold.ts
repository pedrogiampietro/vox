/**
 * Scraper do DeusOLD (https://deusold.com).
 *
 * O site publica HTML renderizado no servidor. O contexto de navegador
 * persistente executa o JavaScript do Cloudflare quando necessario e evita
 * depender de fetch/cookies soltos no processo do bot.
 *
 * Capacidades publicas observadas:
 *   - mortes recentes
 *   - guilds e roster da guild
 *   - ficha de personagem
 *   - total de jogadores por mundo
 *
 * A pagina de mundos nao publica o nome de cada jogador online. Por isso este
 * provider marca `worldOnlineAvailable: false`; o bot nao inventa logins,
 * logouts ou uma lista online a partir de um contador agregado.
 */

import { PersistentBrowserHtml } from './browser.js';
import {
  epochToMs,
  normalizeVocation,
  type GameProvider,
  type ProviderCharacter,
  type ProviderDeath,
  type ProviderGuild,
  type ProviderGuildMember,
  type ProviderOnlinePlayer,
} from './provider.js';

const BASE = 'https://deusold.com';
const browser = new PersistentBrowserHtml({ id: 'deusold', label: 'DeusOLD', baseUrl: BASE });

function strip(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function tbodyBlocks(html: string): string[] {
  return [...html.matchAll(/<tbody\b[\s\S]*?<\/tbody>/gi)].map((match) => match[0]);
}

function rowsFromTbody(tbody: string): string[][] {
  return tbody
    .split(/<tr\b/i)
    .slice(1)
    .map((row) =>
      row
        .split(/<td\b/i)
        .slice(1)
        .map((cell) => strip(cell.slice(cell.indexOf('>') + 1))),
    )
    .filter((cells) => cells.length > 0);
}

function tableRows(html: string, tableIndex = 0): string[][] {
  const blocks = tbodyBlocks(html);
  return blocks[tableIndex] ? rowsFromTbody(blocks[tableIndex]!) : [];
}

function rawRows(html: string, tableIndex = 0): string[] {
  const blocks = tbodyBlocks(html);
  if (!blocks[tableIndex]) return [];
  return blocks[tableIndex]!.split(/<tr\b/i).slice(1);
}

function toInt(value: string | undefined): number {
  const parsed = Number.parseInt((value ?? '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseDeathTime(text: string): number {
  const match = text.match(/(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4}),?\s+(\d{1,2}):(\d{2})/);
  if (!match) return Date.now();
  const month = MONTHS[match[2]!.toLowerCase()];
  if (month === undefined) return Date.now();
  const utc = Date.UTC(
    Number(match[3]),
    month,
    Number(match[1]),
    Number(match[4]) + 3,
    Number(match[5]),
  );
  return epochToMs(utc);
}

async function get(path: string, signal?: AbortSignal): Promise<string> {
  return browser.get(path, signal);
}

// ---------------------------------------------------------------- worlds --

let worldFilters: Map<string, string> | null = null;
let worldFiltersAt = 0;
const WORLD_TTL_MS = 30 * 60_000;

function mapOptions(html: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of html.matchAll(/<option\b[^>]*value=["']([^"']+)["'][^>]*>([\s\S]*?)<\/option>/gi)) {
    const value = match[1]!.trim();
    const name = strip(match[2]!);
    if (value && value !== 'all' && name) map.set(name.toLowerCase(), value);
  }
  return map;
}

async function worldMap(signal?: AbortSignal): Promise<Map<string, string>> {
  if (worldFilters && Date.now() - worldFiltersAt < WORLD_TTL_MS) return worldFilters;

  // O filtro aparece nas paginas de mortes/ranking, enquanto /worlds mostra
  // somente o resumo do mundo.
  const html = await get('/community/deaths', signal);
  const map = mapOptions(html);
  if (map.size > 0) {
    worldFilters = map;
    worldFiltersAt = Date.now();
  }
  return map;
}

export async function listWorlds(signal?: AbortSignal): Promise<string[]> {
  const html = await get('/community/worlds', signal);
  return tableRows(html)
    .map((row) => row[0] ?? '')
    .filter(Boolean);
}

async function worldQuery(world: string, signal?: AbortSignal): Promise<string> {
  const wanted = world.trim();
  if (!wanted) return '';
  const map = await worldMap(signal);
  const filter = map.get(wanted.toLowerCase());
  if (!filter) {
    throw new Error(
      `deusold: mundo "${wanted}" nao existe (disponiveis: ${[...map.keys()].join(', ')})`,
    );
  }
  return `?world_filter=${encodeURIComponent(filter)}`;
}

// ---------------------------------------------------------------- online --

/** DeusOLD publica apenas a contagem agregada, sem roster de personagens. */
export async function fetchWorldOnline(
  _world: string,
  _signal?: AbortSignal,
): Promise<ProviderOnlinePlayer[]> {
  return [];
}

// ---------------------------------------------------------------- deaths --

export async function fetchDeaths(
  world: string,
  signal?: AbortSignal,
): Promise<ProviderDeath[]> {
  const query = await worldQuery(world, signal);
  const html = await get(`/community/deaths${query}`, signal);
  const out: ProviderDeath[] = [];

  for (const row of rawRows(html)) {
    const cells = row
      .split(/<td\b/i)
      .slice(1)
      .map((cell) => cell.slice(cell.indexOf('>') + 1));
    if (cells.length < 5) continue;

    const victim = strip(cells[1] ?? '');
    if (!victim) continue;
    const killerCell = cells[3] ?? '';
    out.push({
      victim,
      level: toInt(strip(cells[2] ?? '')),
      killedBy: strip(killerCell),
      killerIsPlayer: /\/character\//i.test(killerCell),
      world: strip(cells[4] ?? ''),
      timestamp: parseDeathTime(strip(cells[0] ?? '')),
    });
  }
  return out;
}

// ---------------------------------------------------------------- guilds --

const guildIds = new Map<string, number>();

async function guildId(name: string, signal?: AbortSignal): Promise<number | null> {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  const cached = guildIds.get(key);
  if (cached !== undefined) return cached;

  const html = await get(`/community/guilds?search=${encodeURIComponent(name)}`, signal);
  const blocks = tbodyBlocks(html);
  const guildTable = blocks[blocks.length - 1] ?? '';
  let fallback: number | null = null;

  for (const row of guildTable.split(/<tr\b/i).slice(1)) {
    const id = Number(row.match(/\/community\/guild\/(\d+)/i)?.[1] ?? 0);
    if (!id) continue;
    if (fallback === null) fallback = id;
    const guildName = strip(row.match(/<span\b[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? '');
    if (guildName.toLowerCase() === key) {
      guildIds.set(key, id);
      return id;
    }
  }

  if (fallback !== null) guildIds.set(key, fallback);
  return fallback;
}

export async function fetchGuild(
  name: string,
  signal?: AbortSignal,
): Promise<ProviderGuild | null> {
  const id = await guildId(name, signal);
  if (id === null) return null;

  const html = await get(`/community/guild/${id}`, signal);
  const members: ProviderGuildMember[] = [];
  for (const cells of tableRows(html)) {
    const memberName = cells[1] ?? '';
    if (!memberName) continue;
    members.push({
      name: memberName,
      level: toInt(cells[3]),
      vocation: normalizeVocation(cells[2] ?? ''),
      // O roster do DeusOLD nao publica o status online por membro.
      isOnline: false,
    });
  }

  if (members.length === 0) return null;
  const title = strip(html.match(/<h1\b[^>]*>([\s\S]{0,160}?)<\/h1>/i)?.[1] ?? '');
  return { name: title || name, members };
}

// ------------------------------------------------------------- character --

function charField(html: string, ...labels: string[]): string {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = html.match(
      new RegExp(`<div\\b[^>]*>\\s*${escaped}:?\\s*<\\/div>\\s*<div\\b[^>]*>([\\s\\S]*?)<\\/div>`, 'i'),
    );
    const value = strip(match?.[1] ?? '');
    if (value) return value;
  }
  return '';
}

export async function fetchCharacter(
  name: string,
  signal?: AbortSignal,
): Promise<ProviderCharacter | null> {
  let html: string;
  try {
    html = await get(`/character/${encodeURIComponent(name)}`, signal);
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    return null;
  }

  const level = toInt(charField(html, 'Level'));
  const vocation = normalizeVocation(charField(html, 'Profissão', 'Profissao', 'Vocation'));
  if (level === 0 && !vocation) return null;

  return {
    name: charField(html, 'Nome', 'Name') || name,
    level,
    vocation,
    world: charField(html, 'Mundo', 'World'),
    // A ficha publica "Último login", nao um estado online confiavel.
    online: false,
  };
}

export const deusoldProvider: GameProvider = {
  id: 'deusold',
  label: 'DeusOLD',
  worldOnlineAvailable: false,
  fetchWorldOnline,
  fetchDeaths,
  fetchGuild,
  fetchCharacter,
  close: () => browser.close(),
};

export async function closeDeusoldBrowser(): Promise<void> {
  await browser.close();
}

