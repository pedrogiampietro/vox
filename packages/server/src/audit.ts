/**
 * Trilha de auditoria das acoes administrativas.
 *
 * Guarda quem fez, de onde, o que e sobre qual servidor. E o registro que
 * responde "quem removeu esse canal?" e "de onde saiu esse ban?" depois do
 * fato — o log do journal se perde na rotacao e nao separa por servidor.
 *
 * Escrever aqui nunca pode derrubar a acao que estava sendo auditada: um
 * disco cheio deve custar o registro, nao o kick. Por isso `record` engole a
 * propria falha e apenas avisa no console.
 */

import { database } from './sqlite.js';

database.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    actor_account_id INTEGER,
    ip TEXT NOT NULL,
    action TEXT NOT NULL,
    server_id INTEGER,
    detail TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (at DESC);
  CREATE INDEX IF NOT EXISTS audit_log_server ON audit_log (server_id, at DESC);
`);

/** Quantidade mantida por servidor; o excedente e podado na escrita. */
const KEEP_PER_SERVER = 2_000;
/** Registros sem servidor (login, conta, checkout) tem o proprio teto. */
const KEEP_GLOBAL = 5_000;

export type AuditActor = 'master' | 'owner' | 'anon' | 'system';

export interface AuditEntry {
  id: number;
  at: number;
  actor: AuditActor;
  actorAccountId: number | null;
  ip: string;
  action: string;
  serverId: number | null;
  detail: Record<string, unknown>;
}

export interface AuditInput {
  actor: AuditActor;
  actorAccountId: number | null;
  ip: string;
  /** Verbo no formato `dominio.acao`, ex.: `client.ban`, `bot.start`. */
  action: string;
  serverId?: number | null;
  detail?: Record<string, unknown>;
}

let writes = 0;

export function record(input: AuditInput): void {
  try {
    const serverId = input.serverId ?? null;
    database.prepare(`
      INSERT INTO audit_log (at, actor, actor_account_id, ip, action, server_id, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      Date.now(),
      input.actor,
      input.actorAccountId,
      input.ip,
      input.action,
      serverId,
      JSON.stringify(input.detail ?? {}),
    );
    // Podar a cada escrita seria varrer a tabela inteira por kick; a cada 200
    // o custo some e o teto continua valendo na pratica.
    if (++writes % 200 === 0) prune();
  } catch (error) {
    console.warn('[audit] não foi possível registrar:', error);
  }
}

export interface AuditQuery {
  /** `undefined` traz tudo; `null` traz so o que nao pertence a um servidor. */
  serverId?: number | null;
  /** Restringe a uma conta — o dono nunca ve acao de outro cliente. */
  accountId?: number;
  limit?: number;
  /** Paginacao: so registros anteriores a este id. */
  before?: number;
}

export function list(query: AuditQuery = {}): AuditEntry[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (query.serverId !== undefined) {
    if (query.serverId === null) {
      where.push('server_id IS NULL');
    } else {
      where.push('server_id = ?');
      params.push(query.serverId);
    }
  }
  if (query.accountId !== undefined) {
    where.push('actor_account_id = ?');
    params.push(query.accountId);
  }
  if (query.before !== undefined) {
    where.push('id < ?');
    params.push(query.before);
  }
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  const rows = database.prepare(`
    SELECT * FROM audit_log
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY id DESC LIMIT ?
  `).all(...params, limit) as Record<string, unknown>[];
  return rows.map(fromRow);
}

function isActor(value: unknown): value is AuditActor {
  return value === 'master' || value === 'owner' || value === 'anon' || value === 'system';
}

function fromRow(row: Record<string, unknown>): AuditEntry {
  let detail: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(String(row.detail ?? '{}'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      detail = parsed as Record<string, unknown>;
    }
  } catch {
    // Registro antigo ou corrompido nao invalida a listagem inteira.
  }
  return {
    id: Number(row.id),
    at: Number(row.at),
    actor: isActor(row.actor) ? row.actor : 'anon',
    actorAccountId: row.actor_account_id === null ? null : Number(row.actor_account_id),
    ip: String(row.ip ?? ''),
    action: String(row.action ?? ''),
    serverId: row.server_id === null ? null : Number(row.server_id),
    detail,
  };
}

/** Mantem a tabela limitada sem exigir manutencao manual na VPS. */
function prune(): void {
  database.exec(`
    DELETE FROM audit_log WHERE server_id IS NULL AND id NOT IN (
      SELECT id FROM audit_log WHERE server_id IS NULL ORDER BY id DESC LIMIT ${KEEP_GLOBAL}
    )
  `);
  const servers = database
    .prepare('SELECT DISTINCT server_id FROM audit_log WHERE server_id IS NOT NULL')
    .all() as { server_id: number }[];
  for (const { server_id: id } of servers) {
    database.prepare(`
      DELETE FROM audit_log WHERE server_id = ? AND id NOT IN (
        SELECT id FROM audit_log WHERE server_id = ? ORDER BY id DESC LIMIT ${KEEP_PER_SERVER}
      )
    `).run(id, id);
  }
}
