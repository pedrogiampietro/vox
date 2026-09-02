import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { config } from './config.js';

export interface Account {
  id: number;
  email: string;
  passwordHash: string;
  createdAt: number;
}

const FILE = (): string => join(config.dataDir, 'accounts.json');

let accounts: Account[] | null = null;
let nextId = 1;

export function findAccount(email: string): Account | undefined {
  return load().find((account) => account.email === normalizeEmail(email));
}

export function createAccount(email: string, password: string): Account | null {
  const normalized = normalizeEmail(email);
  if (!normalized || password.length < 8 || findAccount(normalized)) return null;
  const account: Account = {
    id: nextId++,
    email: normalized,
    passwordHash: hashPassword(password),
    createdAt: Date.now(),
  };
  load().push(account);
  save();
  return account;
}

export function verifyPassword(account: Account, password: string): boolean {
  const [salt, expected] = account.passwordHash.split(':');
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 32).toString('hex');
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function load(): Account[] {
  if (accounts) return accounts;
  try {
    const parsed = JSON.parse(readFileSync(FILE(), 'utf8')) as Account[];
    accounts = Array.isArray(parsed) ? parsed : [];
  } catch {
    accounts = [];
  }
  nextId = Math.max(0, ...accounts.map((account) => account.id)) + 1;
  return accounts;
}

function save(): void {
  mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${FILE()}.tmp`;
  writeFileSync(tmp, JSON.stringify(load(), null, 2));
  renameSync(tmp, FILE());
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
