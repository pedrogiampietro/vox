import { randomBytes } from 'node:crypto';
import { database } from './sqlite.js';

export type TicketStatus = 'open' | 'waiting' | 'resolved' | 'closed';
export type TicketAuthorRole = 'owner' | 'master';

export interface TicketMessage {
  id: number;
  authorRole: TicketAuthorRole;
  authorAccountId: number | null;
  body: string;
  createdAt: number;
}

export interface SupportTicket {
  id: string;
  accountId: number;
  serverId: number | null;
  serverName: string;
  subject: string;
  status: TicketStatus;
  createdAt: number;
  updatedAt: number;
  messages: TicketMessage[];
}

export function createTicket(input: {
  accountId: number;
  serverId: number | null;
  subject: string;
  body: string;
}): SupportTicket {
  const now = Date.now();
  const id = `vox-ticket-${randomBytes(8).toString('hex')}`;
  database.prepare(`
    INSERT INTO support_tickets
      (id, account_id, server_id, subject, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'open', ?, ?)
  `).run(id, input.accountId, input.serverId, input.subject, now, now);
  database.prepare(`
    INSERT INTO support_ticket_messages
      (ticket_id, author_role, author_account_id, body, created_at)
    VALUES (?, 'owner', ?, ?, ?)
  `).run(id, input.accountId, input.body, now);
  return getTicket(id)!;
}

export function listTickets(accountId: number | null): SupportTicket[] {
  const rows = accountId === null
    ? database.prepare('SELECT * FROM support_tickets ORDER BY updated_at DESC').all() as Record<string, unknown>[]
    : database.prepare('SELECT * FROM support_tickets WHERE account_id = ? ORDER BY updated_at DESC').all(accountId) as Record<string, unknown>[];
  return rows.map((row) => fromRow(row));
}

export function getTicket(id: string): SupportTicket | undefined {
  const row = database.prepare('SELECT * FROM support_tickets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? fromRow(row) : undefined;
}

export function addTicketMessage(
  ticketId: string,
  authorRole: TicketAuthorRole,
  authorAccountId: number | null,
  body: string,
): SupportTicket | undefined {
  const now = Date.now();
  const result = database.prepare(`
    INSERT INTO support_ticket_messages
      (ticket_id, author_role, author_account_id, body, created_at)
    SELECT ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM support_tickets WHERE id = ?)
  `).run(ticketId, authorRole, authorAccountId, body, now, ticketId);
  if (result.changes === 0) return undefined;
  database.prepare('UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?')
    .run(authorRole === 'master' ? 'waiting' : 'open', now, ticketId);
  return getTicket(ticketId);
}

export function updateTicketStatus(id: string, status: TicketStatus): SupportTicket | undefined {
  const result = database.prepare('UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, Date.now(), id);
  return result.changes === 0 ? undefined : getTicket(id);
}

function fromRow(row: Record<string, unknown>): SupportTicket {
  const messages = database.prepare(`
    SELECT id, author_role, author_account_id, body, created_at
    FROM support_ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC, id ASC
  `).all(String(row.id)) as Record<string, unknown>[];
  return {
    id: String(row.id),
    accountId: Number(row.account_id),
    serverId: row.server_id === null ? null : Number(row.server_id),
    serverName: serverName(row.server_id),
    subject: String(row.subject),
    status: normalizeStatus(row.status),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    messages: messages.map((message) => ({
      id: Number(message.id),
      authorRole: message.author_role === 'master' ? 'master' : 'owner',
      authorAccountId: message.author_account_id === null ? null : Number(message.author_account_id),
      body: String(message.body),
      createdAt: Number(message.created_at),
    })),
  };
}

function serverName(serverId: unknown): string {
  if (serverId === null || serverId === undefined) return 'Conta Vox';
  const row = database.prepare('SELECT name FROM servers WHERE id = ?').get(Number(serverId)) as { name?: string } | undefined;
  return row?.name ?? 'Servidor removido';
}

function normalizeStatus(value: unknown): TicketStatus {
  return value === 'waiting' || value === 'resolved' || value === 'closed' ? value : 'open';
}
