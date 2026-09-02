/**
 * Servidores favoritos, guardados neste navegador.
 *
 * Cada favorito carrega apelido e senha proprios: a mesma pessoa costuma ser
 * "Pedro" num servidor e outra coisa no do trabalho, e digitar tudo de novo a
 * cada conexao e o tipo de atrito que faz o usuario nao voltar.
 */

const STORAGE_KEY = 'vox.favorites';

export interface Favorite {
  id: string;
  label: string;
  /** Vazio = a origem desta pagina. */
  address: string;
  /** Servidor virtual; 0 = o primeiro do processo. */
  serverId: number;
  nickname: string;
  password: string;
  lastUsed: number;
}

/** Resumo publico que o /health entrega, para mostrar lotacao antes de entrar. */
export interface ServerStatus {
  id: number;
  name: string;
  motd: string;
  clients: number;
  maxClients: number;
  channels: number;
  protected: boolean;
}

export function listFavorites(): Favorite[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as Favorite[];
    return Array.isArray(raw) ? raw.sort((a, b) => b.lastUsed - a.lastUsed) : [];
  } catch {
    return [];
  }
}

export function saveFavorite(favorite: Favorite): void {
  const all = listFavorites().filter((f) => f.id !== favorite.id);
  all.push(favorite);
  write(all);
}

export function removeFavorite(id: string): void {
  write(listFavorites().filter((f) => f.id !== id));
}

export function touchFavorite(id: string): void {
  const all = listFavorites();
  const found = all.find((f) => f.id === id);
  if (!found) return;
  found.lastUsed = Date.now();
  write(all);
}

export function newFavoriteId(): string {
  return `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function write(all: Favorite[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // modo privado: os favoritos valem so por esta sessao
  }
}

/**
 * Consulta o /health antes de conectar.
 *
 * Vale a pena porque responde a pergunta que a pessoa realmente tem - "tem
 * alguem online?" - sem gastar um handshake completo nem ocupar uma vaga.
 */
export async function probe(address: string, signal?: AbortSignal): Promise<ServerStatus[] | null> {
  const base = healthUrl(address);
  try {
    const res = await fetch(base, signal ? { signal } : {});
    if (!res.ok) return null;
    const body = (await res.json()) as { servers?: ServerStatus[] };
    return body.servers ?? null;
  } catch {
    return null;
  }
}

function healthUrl(address: string): string {
  const raw = address.trim();
  if (!raw) return '/health';
  const host = raw.replace(/^wss?:\/\//i, '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const withPort = /:\d+$/.test(host) || host.endsWith(']') || location.protocol === 'https:'
    ? host
    : `${host}:9987`;
  // Fora do navegador seguro nao da para adivinhar o esquema; segue o da pagina.
  const scheme = location.protocol === 'https:' ? 'https' : 'http';
  return `${scheme}://${withPort}/health`;
}
