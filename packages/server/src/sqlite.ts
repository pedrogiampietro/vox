import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
}

export function exportJson(name: string, value: unknown): void {
  const file = join(config.dataDir, name);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}
