import type { VoiceEdge } from '@vox/protocol';

/** Estado mínimo que o plano de controle conhece sobre um edge. */
export interface VoiceEdgeRoutingHealth {
  id: string;
  connected: boolean;
  available: boolean;
  lastSeenAt: number;
  sessions: number;
  p95Ms: number;
}

export interface VoiceEdgeRoutingOptions {
  /** Estado observado no upstream privado; ausente = edge ainda não foi visto. */
  health?: readonly VoiceEdgeRoutingHealth[];
  /** Identifica o servidor virtual para manter afinidade estável. */
  serverId: number;
  /** Origem direta, usada por último como fallback. */
  origin?: VoiceEdge | null;
  now?: number;
}

const EDGE_STALE_MS = 20_000;

/**
 * Ordena os candidatos de voz sem esconder a topologia do cliente.
 *
 * A origem fornece a afinidade estável por servidor virtual, enquanto o
 * navegador continua validando a distância real com o handshake QUIC. Edges
 * que o Node sabe que estão offline ficam depois da origem e continuam no
 * anúncio para permitir recuperação sem reiniciar o processo.
 */
export function orderVoiceEdges(
  edges: readonly VoiceEdge[],
  options: VoiceEdgeRoutingOptions,
): VoiceEdge[] {
  const unique = dedupeEdges(edges);
  const configuredOrigin = options.origin;
  const origin = configuredOrigin && unique.some((edge) => isSameEdge(edge, configuredOrigin))
    ? configuredOrigin
    : null;
  const regional = unique.filter((edge) => !origin || !isSameEdge(edge, origin));
  const health = new Map<string, VoiceEdgeRoutingHealth>();
  for (const item of options.health ?? []) {
    const id = normalizeId(item.id);
    if (id) health.set(id, item);
  }

  const usable = regional.filter((edge) => isUsable(edge, health, options.now ?? Date.now()));
  // If every observed edge is unavailable/stale, do not make one of them
  // compete with the origin. Unknown edges remain valid because they may be
  // booting and have not sent their first heartbeat yet.
  const unknown = regional.filter((edge) => !findHealth(edge, health));
  const preferredCandidates = usable.length > 0 ? usable : unknown;
  const primary = chooseStablePrimary(preferredCandidates, options.serverId, health);
  const preferred = primary ? [primary] : [];
  const remaining = preferredCandidates
    .filter((edge) => !primary || !isSameEdge(edge, primary))
    .sort((a, b) => compareHealth(a, b, health) || stableScore(b, options.serverId) - stableScore(a, options.serverId));
  const offline = regional
    .filter((edge) => !preferredCandidates.some((candidate) => isSameEdge(candidate, edge)))
    .sort((a, b) => compareHealth(a, b, health));

  // A origem nunca compete com um edge regional saudável. Ela fica disponível
  // imediatamente quando todos os edges remotos estiverem indisponíveis.
  return [...preferred, ...remaining, ...(origin ? [origin] : []), ...offline];
}

function dedupeEdges(edges: readonly VoiceEdge[]): VoiceEdge[] {
  const seen = new Set<string>();
  const result: VoiceEdge[] = [];
  for (const edge of edges) {
    if (!edge.host || !Number.isInteger(edge.port) || edge.port < 1 || edge.port > 65535) continue;
    const key = `${edge.host.toLowerCase()}:${edge.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...edge, certHash: edge.certHash.slice() });
  }
  return result;
}

function isUsable(
  edge: VoiceEdge,
  health: Map<string, VoiceEdgeRoutingHealth>,
  now: number,
): boolean {
  const state = findHealth(edge, health);
  // Sem observação, o edge continua candidato: isso permite o primeiro
  // upstream se registrar depois do boot da origem.
  if (!state || state.lastSeenAt <= 0) return true;
  if (now - state.lastSeenAt > EDGE_STALE_MS) return false;
  return state.connected || state.available;
}

function chooseStablePrimary(
  edges: readonly VoiceEdge[],
  serverId: number,
  health: Map<string, VoiceEdgeRoutingHealth>,
): VoiceEdge | null {
  let selected: VoiceEdge | null = null;
  let selectedScore = -1;
  for (const edge of edges) {
    const score = stableScore(edge, serverId);
    if (!selected || compareHealth(edge, selected, health) < 0
      || (compareHealth(edge, selected, health) === 0 && score > selectedScore)) {
      selected = edge;
      selectedScore = score;
    }
  }
  return selected;
}

function compareHealth(
  a: VoiceEdge,
  b: VoiceEdge,
  health: Map<string, VoiceEdgeRoutingHealth>,
): number {
  const aState = findHealth(a, health);
  const bState = findHealth(b, health);
  const aReady = aState?.connected || aState?.available ? 0 : 1;
  const bReady = bState?.connected || bState?.available ? 0 : 1;
  if (aReady !== bReady) return aReady - bReady;
  const aP95 = aState?.p95Ms || Number.POSITIVE_INFINITY;
  const bP95 = bState?.p95Ms || Number.POSITIVE_INFINITY;
  if (aP95 !== bP95) return aP95 - bP95;
  return (aState?.sessions ?? 0) - (bState?.sessions ?? 0);
}

function findHealth(edge: VoiceEdge, health: Map<string, VoiceEdgeRoutingHealth>): VoiceEdgeRoutingHealth | undefined {
  const host = normalizeId(edge.host);
  const region = normalizeId(edge.region);
  const firstLabel = host.split('.')[0] ?? host;
  return health.get(host)
    ?? health.get(`${host}:${edge.port}`)
    ?? health.get(region)
    ?? health.get(firstLabel)
    ?? [...health.values()].find((item) => {
      const id = normalizeId(item.id);
      return Boolean(id) && (id === host || id === region || id === firstLabel || host.includes(id) || id.includes(firstLabel));
    });
}

function stableScore(edge: VoiceEdge, serverId: number): number {
  let hash = 2166136261 ^ (serverId >>> 0);
  const value = `${edge.host}:${edge.port}`.toLowerCase();
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function isSameEdge(a: VoiceEdge, b: VoiceEdge): boolean {
  return a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port;
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}
