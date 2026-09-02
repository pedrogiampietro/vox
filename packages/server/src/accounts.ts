import { readFileSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { database, exportJson } from './sqlite.js';

export interface Account {
  id: number;
  email: string;
  passwordHash: string;
  createdAt: number;
}

let imported = false;

export function findAccount(email: string): Account | undefined {
  importLegacy();
  return database.prepare('SELECT id, email, password_hash AS passwordHash, created_at AS createdAt FROM accounts WHERE email = ?').get(normalizeEmail(email)) as Account | undefined;
}

export function createAccount(email: string, password: string): Account | null {
  const normalized = normalizeEmail(email);
  if (!normalized || password.length < 8 || findAccount(normalized)) return null;
  const account: Account = {
    id: Number(database.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM accounts').get()?.id ?? 1),
    email: normalized,
    passwordHash: hashPassword(password),
    createdAt: Date.now(),
  };
  database.prepare('INSERT INTO accounts (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run(account.id, account.email, account.passwordHash, account.createdAt);
  exportAccounts();
  return account;
}

/** Cria uma conta nova ou recupera a existente com a senha correta. */
export function ensureAccount(email: string, password: string): Account | null {
  const existing = findAccount(email);
  if (existing) return verifyPassword(existing, password) ? existing : null;
  return createAccount(email, password);
}

export function verifyPassword(account: Account, password: string): boolean {
  const [salt, expected] = account.passwordHash.split(':');
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 32).toString('hex');
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function importLegacy(): void {
  if (imported) return;
  imported = true;
  const count = Number(database.prepare('SELECT COUNT(*) AS count FROM accounts').get()?.count ?? 0);
  if (count === 0) {
    try {
      const parsed = JSON.parse(readFileSync(`${config.dataDir}/accounts.json`, 'utf8')) as Account[];
      if (Array.isArray(parsed)) {
        const insert = database.prepare('INSERT OR IGNORE INTO accounts (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)');
        for (const account of parsed) insert.run(account.id, account.email, account.passwordHash, account.createdAt);
      }
    } catch { /* arquivo ausente */ }
  }
  exportAccounts();
}

function exportAccounts(): void {
  const rows = database.prepare('SELECT id, email, password_hash AS passwordHash, created_at AS createdAt FROM accounts ORDER BY id').all();
  exportJson('accounts.json', rows);
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
