import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PRESET_ID } from '@vox/protocol';
import { config } from './config.js';

mkdirSync(config.dataDir, { recursive: true });
export const database = new DatabaseSync(join(config.dataDir, 'vox.db'));
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS servers (
    id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, owner_id INTEGER,
    name TEXT NOT NULL, motd TEXT NOT NULL, password TEXT NOT NULL,
    max_clients INTEGER NOT NULL, channels_json TEXT NOT NULL,
    groups_json TEXT NOT NULL, bans_json TEXT NOT NULL, group_defs_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS payment_orders (
    id TEXT PRIMARY KEY, account_id INTEGER NOT NULL, plan TEXT NOT NULL,
    amount_cents INTEGER NOT NULL, server_name TEXT NOT NULL,
    server_slug TEXT NOT NULL, server_password TEXT NOT NULL,
    status TEXT NOT NULL, preference_id TEXT NOT NULL, payment_id TEXT NOT NULL,
    server_id INTEGER, last_error TEXT NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

// Migracoes incrementais — cada uma roda so se a coluna ainda nao existe.
{
  const cols = database.prepare("PRAGMA table_info('servers')").all() as { name: string }[];
  const has = new Set(cols.map((c) => c.name));
  if (!has.has('bot_config_json')) {
    database.exec("ALTER TABLE servers ADD COLUMN bot_config_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!has.has('claims_json')) {
    database.exec("ALTER TABLE servers ADD COLUMN claims_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!has.has('descriptions_json')) {
    database.exec("ALTER TABLE servers ADD COLUMN descriptions_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!has.has('permissions_json')) {
    database.exec("ALTER TABLE servers ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!has.has('preset_id')) {
    // Servidores que ja existem foram montados com o layout do Rubinot; o
    // default preserva o comportamento deles sem intervencao do dono.
    database.exec(
      `ALTER TABLE servers ADD COLUMN preset_id TEXT NOT NULL DEFAULT '${DEFAULT_PRESET_ID}'`,
    );
  }
  if (!has.has('custom_preset_json')) {
    // So preenchido quando o preset veio de importacao; presets embutidos
    // ficam vazios e sao resolvidos por preset_id.
    database.exec("ALTER TABLE servers ADD COLUMN custom_preset_json TEXT NOT NULL DEFAULT ''");
  }
}

// Dados comerciais adicionados depois que o checkout inicial entrou em produção.
// As colunas novas são opcionais para preservar pedidos antigos já gravados.
{
  const cols = database.prepare("PRAGMA table_info('payment_orders')").all() as { name: string }[];
  const has = new Set(cols.map((c) => c.name));
  if (!has.has('kind')) database.exec("ALTER TABLE payment_orders ADD COLUMN kind TEXT NOT NULL DEFAULT 'initial'");
  if (!has.has('paid_at')) database.exec('ALTER TABLE payment_orders ADD COLUMN paid_at INTEGER');
  if (!has.has('expires_at')) database.exec('ALTER TABLE payment_orders ADD COLUMN expires_at INTEGER');
  if (!has.has('payment_method_id')) database.exec("ALTER TABLE payment_orders ADD COLUMN payment_method_id TEXT NOT NULL DEFAULT ''");
  if (!has.has('payment_type_id')) database.exec("ALTER TABLE payment_orders ADD COLUMN payment_type_id TEXT NOT NULL DEFAULT ''");
  if (!has.has('status_detail')) database.exec("ALTER TABLE payment_orders ADD COLUMN status_detail TEXT NOT NULL DEFAULT ''");

  // Pedidos aprovados antes da migração já têm updated_at no momento da
  // confirmação. Isso permite mostrar um vencimento coerente imediatamente;
  // pagamentos novos passam a usar a data_approved retornada pelo Mercado Pago.
  database.prepare(`
    UPDATE payment_orders
    SET paid_at = updated_at,
        expires_at = updated_at + 2592000000
    WHERE status = 'approved' AND paid_at IS NULL
  `).run();
}

export function exportJson(name: string, value: unknown): void {
  const file = join(config.dataDir, name);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}
