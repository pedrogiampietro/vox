/**
 * Presets de servidor.
 *
 * Um servidor Vox pode atender OTs muito diferentes — Rubinot, Tibia Global,
 * um 7.4 antigo — e cada um muda tres coisas ao mesmo tempo:
 *
 *   1. os canais    (as hunts de um 7.4 nao existem num global moderno)
 *   2. os respawns  (o catalogo dos claims tem que refletir o mapa do servidor)
 *   3. a fonte      (o scraper do Rubinot nao serve pra outro OT)
 *
 * Tratar isso como tres sistemas soltos levaria a estados incoerentes: canais
 * de 7.4 com claim oferecendo Cobra Bastion. Por isso o preset embrulha os
 * tres num objeto so, e o servidor guarda qual esta ativo.
 *
 * Presets embutidos vivem aqui. Presets proprios entram por importacao de
 * JSON (Op.SetPreset com `custom`), sem precisar de deploy.
 */

import { DEFAULT_GROUP_DEFS, Group } from './types.js';
import type { GroupDef, TemplateCategory } from './types.js';
import { RESPAWN_CATALOG } from './respawns.js';
import type { RespawnCatalogGroup } from './respawns.js';

/**
 * De onde o bot puxa mortes, online e level. `none` desliga o bot: o preset
 * nao tem fonte de dados conhecida, e forcar o scraper do Rubinot num OT
 * diferente so produziria lixo.
 */
export type BotProvider = 'rubinot' | 'deusot' | 'deusold' | 'none';

export interface PresetBotConfig {
  provider: BotProvider;
  /** World sugerida ao aplicar o preset. Vazio = o owner escolhe. */
  world?: string;
  /** Nome do canal onde o bot posta. */
  channelName?: string;
}

export interface ServerPreset {
  /** Identificador estavel. Presets importados usam `custom:<algo>`. */
  id: string;
  name: string;
  /** Uma linha explicando pra que serve. Aparece no seletor. */
  description: string;
  /** Sobe quando o conteudo muda; deixa detectar preset defasado no futuro. */
  version: number;
  /** Arvore de canais criada ao aplicar. */
  channels: TemplateCategory[];
  /** Catalogo dos claims de respawn. Vazio desliga o recurso no servidor. */
  respawns: RespawnCatalogGroup[];
  bot: PresetBotConfig;
  /** Opcional: a estrutura de cargos raramente muda entre OTs. */
  groups?: GroupDef[];
}

// ------------------------------------------------------------------ rubinot --

/**
 * Canais do Rubinot. Espelha o layout que a guild ja usava no TS3: um bloco
 * de canais numerados pra war, um de respawns e um de salas privadas.
 */
const RUBINOT_CHANNELS: TemplateCategory[] = [
  {
    name: 'CHANELS',
    topic: 'Canais principais / war',
    children: [
      { name: 'TAPETA DARASHIA FAST', topic: '' },
      { name: 'Channel Vermelho', topic: '' },
      { name: 'Channel 01 WAR CHANNEL', topic: 'War channel' },
      { name: 'Channel 02', topic: '' },
      { name: 'Channel 03', topic: '' },
      { name: 'Channel 04', topic: '' },
      { name: 'Channel 05', topic: '' },
      { name: 'Channel 06', topic: '' },
      { name: 'Channel 07', topic: '' },
      { name: 'Channel 08', topic: '' },
      { name: 'Channel 09', topic: '' },
      { name: 'Channel 10', topic: '' },
      { name: 'Channel 11', topic: '' },
      { name: 'Channel 12', topic: '' },
      { name: 'Channel 13', topic: '' },
      { name: 'Channel 14', topic: '' },
      { name: 'Channel 15', topic: '' },
      { name: 'Channel 16', topic: '' },
      { name: 'Channel 17', topic: '' },
      { name: 'Channel 18', topic: '' },
    ],
  },
  {
    name: "HUNT'S",
    topic: 'Respawns e locais de caca',
    children: [
      { name: 'Rotten Wasteland (North)', topic: '' },
      { name: 'Rotten Wasteland (North-West)', topic: '' },
      { name: 'Rotten Wasteland (South-West)', topic: '' },
      { name: 'Livraria - Energy', topic: '' },
      { name: 'Livraria - Fire', topic: '' },
      { name: 'Livraria - Ice', topic: '' },
      { name: 'Mirrored Nightmare (Thais invert)', topic: '' },
      { name: 'Furious Crater (Cloak)', topic: '' },
      { name: 'Claustrophobic Inferno (Brachio)', topic: '' },
      { name: 'Piranha (North)', topic: '' },
      { name: 'Piranha (South)', topic: '' },
      { name: 'Gnomprona (Carrinho 1)', topic: '' },
      { name: 'Gnomprona (Carrinho 2)', topic: '' },
      { name: 'Gnomprona (Carrinho 3)', topic: '' },
      { name: 'Putrefactory', topic: '' },
      { name: 'Jaded Roots', topic: '' },
      { name: 'Gloom Pillars', topic: '' },
      { name: 'Darklight Core', topic: '' },
    ],
  },
  {
    name: 'PRIVATE',
    topic: 'Canais privados',
    children: [
      { name: 'Private 02', topic: '' },
      { name: 'Private 03', topic: '' },
      { name: 'Private 04', topic: '' },
      { name: 'Private 05', topic: '' },
    ],
  },
];

/**
 * Cargos visuais do Rubinot. Os arquivos vivem no diretorio de icones do
 * servidor e sao servidos pelo Vox em /icons/<nome>.png.
 */
export const RUBINOT_GROUP_DEFS: GroupDef[] = DEFAULT_GROUP_DEFS.map((def) => ({
  ...def,
  icon: `/icons/${rubinotIconName(def.id)}.png`,
}));

function rubinotIconName(group: Group): string {
  switch (group) {
    case Group.Guest: return 'visitante';
    case Group.Spy: return 'spy';
    case Group.Member: return 'membro';
    case Group.Elite: return 'elite';
    case Group.Support: return 'suporte';
    case Group.Moderator: return 'moderador';
    case Group.Admin: return 'admin';
    case Group.Owner: return 'leader';
    // Dono e Leader/Owner representam o mesmo cargo visual: usam a caveira
    // de owner, mesmo com o nome e a permissao separados no servidor.
    case Group.Dono: return 'leader';
  }
}

/** Alias mantido para o cliente web legado que aplica o template manualmente. */
export const TIBIA_TEMPLATE: readonly TemplateCategory[] = RUBINOT_CHANNELS;

export const RUBINOT_PRESET: ServerPreset = {
  id: 'rubinot',
  name: 'Rubinot',
  description: 'OT global moderno. Bot com mortes, level up, transfers e Former Names via API do Rubinot.',
  version: 1,
  channels: RUBINOT_CHANNELS,
  respawns: RESPAWN_CATALOG,
  bot: { provider: 'rubinot', channelName: 'bot' },
  groups: RUBINOT_GROUP_DEFS,
};

// ------------------------------------------------------------------ deusot --

/**
 * DeusOT (deusot.com). Mesma estrutura do Rubinot — canais, cargos e catalogo
 * de respawn sao os mesmos, porque e o mesmo tipo de OT global. O que muda e
 * so a fonte: o site nao tem API JSON, mas renderiza HTML no servidor, entao o
 * bot raspa as paginas publicas.
 *
 * Tem quatro mundos (Andromeda, Eclipse, Sirius, Titan); o dono escolhe o dele
 * na aba Bot, por isso `world` fica vazio aqui.
 */
export const DEUSOT_PRESET: ServerPreset = {
  id: 'deusot',
  name: 'DeusOT',
  description: 'OT global com 4 mundos. Bot le mortes, level up e presenca do site do DeusOT.',
  version: 1,
  channels: RUBINOT_CHANNELS,
  respawns: RESPAWN_CATALOG,
  bot: { provider: 'deusot', channelName: 'bot' },
  groups: RUBINOT_GROUP_DEFS,
};

// ----------------------------------------------------------------- deusold --

/**
 * DeusOLD e um mundo 7.4 e usa a mesma base de canais/claims por enquanto.
 * O provider coleta mortes, guilds e fichas; o site nao publica roster online.
 */
export const DEUSOLD_PRESET: ServerPreset = {
  id: 'deusold',
  name: 'DeusOLD',
  description: 'OT 7.4. Bot le mortes, guilds e fichas publicas do DeusOLD.',
  version: 1,
  channels: RUBINOT_CHANNELS,
  respawns: RESPAWN_CATALOG,
  bot: { provider: 'deusold', channelName: 'bot' },
  groups: RUBINOT_GROUP_DEFS,
};

// -------------------------------------------------------------------- vazio --

/**
 * Esqueleto pra montar um preset novo.
 *
 * O caminho recomendado nao e editar isto no codigo — e aplicar este preset,
 * arrumar os canais na propria interface e usar "exportar preset", que gera o
 * JSON completo pronto pra reimportar ou compartilhar.
 */
export const BLANK_PRESET: ServerPreset = {
  id: 'blank',
  name: 'Em branco',
  description: 'Base minima pra montar o seu. Aplique, ajuste os canais na interface e exporte.',
  version: 1,
  channels: [
    {
      name: 'GERAL',
      topic: 'Canais de conversa',
      children: [
        { name: 'Lobby', topic: 'Canal de entrada' },
        { name: 'Sala 1', topic: '' },
        { name: 'Sala 2', topic: '' },
      ],
    },
    {
      name: "HUNT'S",
      topic: 'Respawns — troque pelos do seu servidor',
      children: [
        { name: 'Hunt 1', topic: '' },
        { name: 'Hunt 2', topic: '' },
        { name: 'Hunt 3', topic: '' },
      ],
    },
    {
      name: 'PRIVATE',
      topic: 'Canais privados',
      children: [
        { name: 'Private 01', topic: '' },
        { name: 'Private 02', topic: '' },
      ],
    },
  ],
  // Sem catalogo: o painel de claims fica vazio ate voce preencher.
  respawns: [],
  bot: { provider: 'none' },
};

// ----------------------------------------------------------------- registro --

export const SERVER_PRESETS: ServerPreset[] = [RUBINOT_PRESET, DEUSOT_PRESET, DEUSOLD_PRESET, BLANK_PRESET];

export function findPreset(id: string): ServerPreset | undefined {
  return SERVER_PRESETS.find((p) => p.id === id);
}

export const DEFAULT_PRESET_ID = RUBINOT_PRESET.id;

/** Cargos do preset, caindo no padrao quando ele nao define os proprios. */
export function presetGroups(preset: ServerPreset): GroupDef[] {
  return preset.groups?.length ? preset.groups : DEFAULT_GROUP_DEFS;
}

// ---------------------------------------------------------------- respawns --

/**
 * Resolve o nome canonico de um respawn dentro de um preset. Aceita o codigo
 * ("2"), o nome exato ou uma variacao de caixa/acento. Devolve null quando o
 * respawn nao existe no preset — e o que impede claim de hunt inventada.
 */
export function canonicalRespawnIn(preset: ServerPreset, value: string): string | null {
  const wanted = normalizeKey(value);
  if (!wanted) return null;
  for (const group of preset.respawns) {
    for (const item of group.items) {
      if (normalizeKey(item.name) === wanted) return item.name;
      if (item.code.toLowerCase() === wanted) return item.name;
    }
  }
  return null;
}

function normalizeKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

// ------------------------------------------------------------- importacao --

const MAX_CATEGORIES = 40;
const MAX_CHILDREN = 200;
const MAX_RESPAWN_GROUPS = 100;
const MAX_RESPAWN_ITEMS = 400;

/**
 * Teto do JSON serializado. O preset viaja num campo `str` do canal de
 * controle, que tem prefixo u16 e cabe num frame de 64KB — passar disso faria
 * o encoder lancar no meio de um envio. Cortamos bem antes: um preset real
 * (Rubinot, com ~350 respawns) da uns 15KB.
 */
export const MAX_PRESET_JSON = 48 * 1024;

/** Serializa pro transporte. Devolve null quando o preset nao cabe no frame. */
export function serializePreset(preset: ServerPreset): string | null {
  const json = JSON.stringify(preset);
  return byteLength(json) > MAX_PRESET_JSON ? null : json;
}

function byteLength(s: string): number {
  // Sem TextEncoder pra manter o modulo isomorfico; so precisamos do limite.
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/**
 * Valida e normaliza um preset vindo de JSON externo. Retorna null quando o
 * formato nao bate — nunca lanca, porque o chamador e um handler de rede que
 * nao pode cair por causa de arquivo malformado.
 */
export function parsePreset(raw: unknown): ServerPreset | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  const id = str(o.id, 48);
  const name = str(o.name, 48);
  if (!id || !name) return null;

  const channels = parseCategories(o.channels);
  const respawns = parseRespawnGroups(o.respawns);
  const bot = parseBot(o.bot);

  const preset: ServerPreset = {
    id: id.startsWith('custom:') ? id : `custom:${id}`,
    name,
    description: str(o.description, 160),
    version: typeof o.version === 'number' && o.version > 0 ? Math.floor(o.version) : 1,
    channels,
    respawns,
    bot,
  };
  // Os caps por lista sozinhos ainda deixariam passar algo grande demais pro
  // frame de controle; o teto global e o que garante que da pra transmitir.
  return serializePreset(preset) === null ? null : preset;
}

function parseCategories(raw: unknown): TemplateCategory[] {
  if (!Array.isArray(raw)) return [];
  const out: TemplateCategory[] = [];
  for (const c of raw.slice(0, MAX_CATEGORIES)) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    const name = str(o.name, 64);
    if (!name) continue;
    const children: { name: string; topic: string }[] = [];
    if (Array.isArray(o.children)) {
      for (const ch of o.children.slice(0, MAX_CHILDREN)) {
        if (!ch || typeof ch !== 'object') continue;
        const co = ch as Record<string, unknown>;
        const cn = str(co.name, 64);
        if (cn) children.push({ name: cn, topic: str(co.topic, 128) });
      }
    }
    out.push({ name, topic: str(o.topic, 128), children });
  }
  return out;
}

function parseRespawnGroups(raw: unknown): RespawnCatalogGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: RespawnCatalogGroup[] = [];
  for (const g of raw.slice(0, MAX_RESPAWN_GROUPS)) {
    if (!g || typeof g !== 'object') continue;
    const o = g as Record<string, unknown>;
    const title = str(o.title, 96);
    if (!title) continue;
    const items: { code: string; name: string }[] = [];
    if (Array.isArray(o.items)) {
      for (const it of o.items.slice(0, MAX_RESPAWN_ITEMS)) {
        if (!it || typeof it !== 'object') continue;
        const io = it as Record<string, unknown>;
        const n = str(io.name, 96);
        if (n) items.push({ code: str(io.code, 12), name: n });
      }
    }
    out.push({ title, items });
  }
  return out;
}

function parseBot(raw: unknown): PresetBotConfig {
  if (!raw || typeof raw !== 'object') return { provider: 'none' };
  const o = raw as Record<string, unknown>;
  const provider: BotProvider =
    o.provider === 'rubinot' || o.provider === 'deusot' || o.provider === 'deusold'
      ? o.provider
      : 'none';
  return {
    provider,
    world: str(o.world, 32),
    channelName: str(o.channelName, 32) || 'bot',
  };
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
