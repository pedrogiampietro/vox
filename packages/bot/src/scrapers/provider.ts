/**
 * Fonte de dados do bot.
 *
 * Cada OT publica os mesmos fatos — quem esta online, quem morreu, quem esta
 * na guild — de um jeito diferente: o Rubinot tem API JSON, o DeusOT renderiza
 * HTML no servidor. Esta interface e o contrato que o bot enxerga, com tudo ja
 * normalizado, pra que trocar de OT nao vire um `if` espalhado pelo bot.
 *
 * Implementacoes vivem em `rubinot.ts`, `deusot.ts` e `deusold.ts`.
 */

export interface ProviderOnlinePlayer {
  name: string;
  level: number;
  /** Codigo curto: EK/ED/MS/RP/MK, ou '' quando desconhecido. */
  vocation: string;
}

export interface ProviderDeath {
  victim: string;
  level: number;
  killedBy: string;
  /** Distingue PK de morte pra monstro — e o que interessa em war. */
  killerIsPlayer: boolean;
  world: string;
  /** Epoch em milissegundos. */
  timestamp: number;
}

export interface ProviderGuildMember {
  name: string;
  level: number;
  vocation: string;
  isOnline: boolean;
}

export interface ProviderGuild {
  name: string;
  members: ProviderGuildMember[];
}

export interface ProviderCharacter {
  name: string;
  level: number;
  vocation: string;
  world: string;
  online: boolean;
}

export interface GameProvider {
  /** Casa com `bot.provider` do preset. */
  readonly id: string;
  /** Nome exibido em log e mensagens de erro. */
  readonly label: string;

  /**
   * Alguns sites mostram apenas o total online do mundo, sem publicar o
   * roster. Nessa situacao o bot continua operando mortes/guilds, mas nao
   * deve transformar a ausencia do roster em logouts falsos.
   */
  readonly worldOnlineAvailable?: boolean;

  fetchWorldOnline(world: string, signal?: AbortSignal): Promise<ProviderOnlinePlayer[]>;

  /**
   * Mortes recentes. `world` vazio traz todos os mundos — servidores de um
   * mundo so ignoram o filtro.
   */
  fetchDeaths(world: string, signal?: AbortSignal): Promise<ProviderDeath[]>;

  /** null quando a guild nao existe. */
  fetchGuild(name: string, signal?: AbortSignal): Promise<ProviderGuild | null>;

  /** null quando o char nao existe ou a pagina nao deu os dados minimos. */
  fetchCharacter(name: string, signal?: AbortSignal): Promise<ProviderCharacter | null>;

  /** Libera conexoes de longa duracao. Chamado no stop do bot. */
  close(): Promise<void>;
}

/**
 * Vocation em codigo curto. Aceita tanto o nome completo ("Elite Knight")
 * quanto o ja normalizado ("EK"), entao aplicar duas vezes e inofensivo.
 *
 * Vocacoes base (sem promocao) caem no icone da promovida: um Knight lvl 20 e
 * o mesmo boneco de um Elite Knight pra quem le o alerta.
 */
export function normalizeVocation(v: string): string {
  const lower = v.trim().toLowerCase();
  if (!lower) return '';
  if (['ek', 'ed', 'ms', 'rp', 'mk'].includes(lower)) return lower.toUpperCase();
  if (lower.includes('elite knight')) return 'EK';
  if (lower.includes('elder druid')) return 'ED';
  if (lower.includes('master sorcerer')) return 'MS';
  if (lower.includes('royal paladin')) return 'RP';
  // Cobre "Monk" e "Exalted Monk".
  if (lower.includes('monk')) return 'MK';
  if (lower.includes('knight')) return 'EK';
  if (lower.includes('druid')) return 'ED';
  if (lower.includes('sorcerer')) return 'MS';
  if (lower.includes('paladin')) return 'RP';
  return '';
}

/**
 * Vocation pelo enum numerico do Rubinot:
 *   0=None, 1=Sorcerer, 2=Druid, 3=Paladin, 4=Knight,
 *   5=Master Sorcerer, 6=Elder Druid, 7=Royal Paladin, 8=Elite Knight,
 *   9=Monk, 10=Exalted Monk.
 */
export function normalizeVocationNumber(n: number): string {
  switch (n) {
    case 1: case 5: return 'MS';
    case 2: case 6: return 'ED';
    case 3: case 7: return 'RP';
    case 4: case 8: return 'EK';
    case 9: case 10: return 'MK';
    default: return '';
  }
}

/** A API pode enviar epoch em segundos ou milissegundos. */
export function epochToMs(timestamp: number): number {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return Date.now();
  return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
}
