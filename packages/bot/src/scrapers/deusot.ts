/**
 * Fonte de dados do DeusOT (https://deusot.com).
 *
 * Diferente do Rubinot, aqui nao ha API JSON — mas tambem nao ha SPA nem
 * login: o site e Laravel renderizando HTML no servidor, e um `fetch` comum
 * passa pelo Cloudflare sem precisar de cycletls. Entao raspamos as tabelas.
 *
 * Rotas usadas:
 *   /community/worlds                     mundos + o id numerico de cada um
 *   /community/online?world_filter=<id>   nome, level, vocation, mundo
 *   /community/deaths?world_filter=<id>   hora, vitima, level, matador, mundo
 *   /community/guilds?search=<nome>       resolve nome da guild -> id
 *   /community/guild/<id>                 roster com vocation, level, online
 *   /character/<Nome>                     ficha do char
 */

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

const BASE = 'https://deusot.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15_000;

/** Paginas de listagem trazem 50 linhas; mais que isso nao cabe num alerta. */
const MAX_ONLINE_PAGES = 20;

async function get(path: string, signal?: AbortSignal): Promise<string> {
  // Timeout proprio combinado com o abort do bot: o primeiro que disparar vence.
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(`${BASE}${path}`, {
    signal: combined,
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      referer: `${BASE}/`,
    },
  });
  if (!res.ok) throw new Error(`deusot ${path}: HTTP ${res.status}`);
  return res.text();
}

// ------------------------------------------------------------------ html --

/** Texto visivel de um fragmento de HTML, com entidades comuns resolvidas. */
function strip(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Linhas do primeiro <tbody>, cada uma como lista de celulas em texto puro.
 * Ficamos no tbody de proposito: o cabecalho vive no thead e entraria como
 * uma linha falsa se separassemos so por <tr>.
 */
function tableRows(html: string): string[][] {
  const start = html.indexOf('<tbody');
  const end = html.indexOf('</tbody>', start);
  if (start < 0 || end < 0) return [];
  return html
    .slice(start, end)
    .split(/<tr\b/)
    .slice(1)
    .map((row) =>
      row
        .split(/<td\b/)
        .slice(1)
        // Corta os atributos do proprio <td> antes de limpar as tags.
        .map((cell) => strip(cell.slice(cell.indexOf('>') + 1))),
    )
    .filter((cells) => cells.length > 0);
}

/** Mesma separacao de linhas, mas preservando o HTML — pra ler hrefs. */
function rawRows(html: string): string[] {
  const start = html.indexOf('<tbody');
  const end = html.indexOf('</tbody>', start);
  if (start < 0 || end < 0) return [];
  return html.slice(start, end).split(/<tr\b/).slice(1);
}

function toInt(v: string | undefined): number {
  const n = Number.parseInt((v ?? '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * "03 Sep 2026, 22:42" -> epoch ms. O site nao publica timezone; assumimos
 * America/Sao_Paulo, que e onde o servidor roda, e caimos em "agora" se o
 * formato mudar — um horario errado e pior que um aproximado.
 */
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseDeathTime(text: string): number {
  const m = text.match(/(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4}),?\s+(\d{1,2}):(\d{2})/);
  if (!m) return Date.now();
  const month = MONTHS[m[2]!.toLowerCase()];
  if (month === undefined) return Date.now();
  // -03:00 fixo: o Brasil nao usa mais horario de verao.
  const utc = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]) + 3, Number(m[5]));
  return epochToMs(utc);
}

// ----------------------------------------------------------------- mundos --

/**
 * Cache do mapa mundo -> world_filter. Os ids nao seguem a ordem alfabetica
 * (Eclipse=1, Titan=2, Andromeda=3, Sirius=4), entao resolvemos em runtime em
 * vez de fixar no codigo: um mundo novo entra sozinho.
 */
let worldIds: Map<string, number> | null = null;
let worldIdsAt = 0;
const WORLD_TTL_MS = 30 * 60_000;

async function worldMap(signal?: AbortSignal): Promise<Map<string, number>> {
  if (worldIds && Date.now() - worldIdsAt < WORLD_TTL_MS) return worldIds;
  const html = await get('/community/worlds', signal);
  const map = new Map<string, number>();
  for (const row of rawRows(html)) {
    const id = row.match(/world_filter=(\d+)/)?.[1];
    if (!id) continue;
    const name = strip((row.split(/<td\b/)[1] ?? '').replace(/^[^>]*>/, ''));
    if (name) map.set(name.toLowerCase(), Number(id));
  }
  if (map.size > 0) {
    worldIds = map;
    worldIdsAt = Date.now();
  }
  return map;
}

/**
 * Sufixo `?world_filter=N` pro mundo pedido. World vazio devolve sufixo vazio
 * (todos os mundos), que e o que servidores de um mundo so querem.
 *
 * Um nome que nao existe lanca, de proposito: sem filtro a listagem devolveria
 * os quatro mundos juntos, e quem consome a lista de online nao filtra por
 * mundo — o bot passaria a rastrear o servidor inteiro achando que e o alvo.
 * Erro no log e melhor que dado errado em silencio.
 */
async function worldQuery(world: string, signal?: AbortSignal): Promise<string> {
  const wanted = world.trim();
  if (!wanted) return '';
  const map = await worldMap(signal);
  const id = map.get(wanted.toLowerCase());
  if (id === undefined) {
    throw new Error(
      `deusot: mundo "${wanted}" nao existe (disponiveis: ${[...map.keys()].join(', ')})`,
    );
  }
  return `?world_filter=${id}`;
}

export async function listWorlds(signal?: AbortSignal): Promise<string[]> {
  const html = await get('/community/worlds', signal);
  return rawRows(html)
    .filter((row) => /world_filter=\d+/.test(row))
    .map((row) => strip((row.split(/<td\b/)[1] ?? '').replace(/^[^>]*>/, '')))
    .filter(Boolean);
}

// ----------------------------------------------------------------- online --

export async function fetchWorldOnline(
  world: string,
  signal?: AbortSignal,
): Promise<ProviderOnlinePlayer[]> {
  const query = await worldQuery(world, signal);
  const players: ProviderOnlinePlayer[] = [];
  const seen = new Set<string>();

  // A lista e paginada de 50 em 50. Paramos quando a pagina vem vazia ou
  // repete nomes — o site devolve a ultima pagina de novo se `page` estoura.
  for (let page = 1; page <= MAX_ONLINE_PAGES; page++) {
    const sep = query ? '&' : '?';
    const html = await get(`/community/online${query}${sep}page=${page}`, signal);
    const rows = tableRows(html);
    if (rows.length === 0) break;

    let added = 0;
    for (const cells of rows) {
      const name = cells[0] ?? '';
      if (!name || seen.has(name)) continue;
      seen.add(name);
      added++;
      players.push({
        name,
        level: toInt(cells[1]),
        vocation: normalizeVocation(cells[2] ?? ''),
      });
    }
    if (added === 0) break;
  }
  return players;
}

// ----------------------------------------------------------------- mortes --

export async function fetchDeaths(
  world: string,
  signal?: AbortSignal,
): Promise<ProviderDeath[]> {
  const query = await worldQuery(world, signal);
  const html = await get(`/community/deaths${query}`, signal);
  const out: ProviderDeath[] = [];

  for (const row of rawRows(html)) {
    const cells = row
      .split(/<td\b/)
      .slice(1)
      .map((cell) => cell.slice(cell.indexOf('>') + 1));
    if (cells.length < 5) continue;

    const victim = strip(cells[1] ?? '');
    if (!victim) continue;

    // O matador vira link de char quando e jogador, e <span> quando e bicho.
    // E dai que sai killerIsPlayer, que separa PK de morte pra monstro.
    const killerCell = cells[3] ?? '';
    out.push({
      victim,
      level: toInt(strip(cells[2] ?? '')),
      killedBy: strip(killerCell),
      killerIsPlayer: /\/character\//.test(killerCell),
      world: strip(cells[4] ?? ''),
      timestamp: parseDeathTime(strip(cells[0] ?? '')),
    });
  }
  return out;
}

// ----------------------------------------------------------------- guilds --

/**
 * O DeusOT enderca guild por id numerico, nao por nome. Resolvemos pela busca
 * e guardamos, porque o id nao muda.
 */
const guildIds = new Map<string, number>();

async function guildId(name: string, signal?: AbortSignal): Promise<number | null> {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  const cached = guildIds.get(key);
  if (cached !== undefined) return cached;

  const html = await get(`/community/guilds?search=${encodeURIComponent(name)}`, signal);
  // A busca e por substring, entao pode voltar varias. Preferimos o nome
  // exato; sem ele, a primeira — que e a mais proxima do que foi digitado.
  let fallback: number | null = null;
  // O nome da guild fica no `alt` do logo, enquanto o link "Ver" so traz o
  // id. Procurar por link isolado fazia qualquer busca com mais de um
  // resultado escolher sempre a primeira guild da pagina.
  for (const row of html.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)) {
    const fragment = row[0];
    const id = Number(fragment.match(/\/community\/guild\/(\d+)/i)?.[1] ?? 0);
    if (!id) continue;
    if (fallback === null) fallback = id;
    const guildName = strip(fragment.match(/<img\b[^>]*\balt="([^"]+)"/i)?.[1] ?? '');
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
  // Colunas: rank, nome, vocacao, level, status.
  for (const cells of tableRows(html)) {
    const memberName = cells[1] ?? '';
    if (!memberName) continue;
    members.push({
      name: memberName,
      level: toInt(cells[3]),
      vocation: normalizeVocation(cells[2] ?? ''),
      isOnline: /online/i.test(cells[4] ?? '') && !/offline/i.test(cells[4] ?? ''),
    });
  }
  if (members.length === 0) return null;

  const title = strip(html.match(/<h1[^>]*>([\s\S]{0,120}?)<\/h1>/)?.[1] ?? '');
  return { name: title || name, members };
}

// ------------------------------------------------------------- personagem --

/**
 * Ficha do char. A pagina monta cada campo como um par de divs irmas — a
 * primeira com o rotulo ("Level:"), a segunda com o valor. Lemos por esse par
 * em vez de por posicao, entao um campo novo no meio nao quebra a leitura.
 */
function charField(html: string, ...labels: string[]): string {
  for (const label of labels) {
    const at = html.indexOf(`${label}:`);
    if (at < 0) continue;
    // O valor e a proxima div depois do rotulo.
    const open = html.indexOf('<div', at);
    const start = open < 0 ? -1 : html.indexOf('>', open);
    const end = start < 0 ? -1 : html.indexOf('</div>', start);
    if (end < 0) continue;
    const value = strip(html.slice(start + 1, end));
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
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    return null;
  }

  const level = toInt(charField(html, 'Level'));
  const vocation = normalizeVocation(charField(html, 'Profissão', 'Profissao', 'Vocation'));
  // Sem level nem vocation nao ha o que reportar: tratamos como inexistente.
  if (level === 0 && !vocation) return null;

  const status = charField(html, 'Status');
  return {
    name: charField(html, 'Nome', 'Name') || name,
    level,
    vocation,
    world: charField(html, 'Mundo', 'World'),
    online: /online/i.test(status) && !/offline/i.test(status),
  };
}

// --------------------------------------------------------------- provider --

export const deusotProvider: GameProvider = {
  id: 'deusot',
  label: 'DeusOT',
  fetchWorldOnline,
  fetchDeaths,
  fetchGuild,
  fetchCharacter,
  // fetch nativo nao mantem nada aberto que precise ser fechado.
  close: async () => {},
};
