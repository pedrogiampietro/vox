/**
 * Backup automatico do banco.
 *
 * O SQLite roda em WAL: na pratica quase tudo o que foi escrito desde o ultimo
 * checkpoint vive em `vox.db-wal`, nao em `vox.db`. Copiar so o `.db` com o
 * servico no ar produz um arquivo que parece um backup e nao e — foi o que
 * motivou este modulo. `VACUUM INTO` resolve: o proprio SQLite escreve um
 * banco novo, ja compactado e consistente, sem parar ninguem.
 *
 * O que fica de fora, de proposito: `.env` e os certificados do Caddy. Eles
 * carregam segredo e nao mudam sozinhos; copiar isso para um diretorio de
 * rotina transformaria o backup em alvo. O passo a passo manual deles esta em
 * docs/PRODUCAO.md.
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from './config.js';
import { database } from './sqlite.js';
import { record as recordAudit } from './audit.js';

const PREFIX = 'vox-';
const SUFFIX = '.db';
/** Espera antes do backup de boot: subir o servico vem primeiro. */
const BOOT_DELAY_MS = 30_000;

export function backupDir(): string {
  const configured = process.env['VOX_BACKUP_DIR']?.trim();
  return configured ? resolve(configured) : resolve(config.dataDir, 'backups');
}

/** `vox-20260904-0612.db` — ordenavel por nome, legivel por humano. */
function stamp(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export interface BackupResult {
  path: string;
  bytes: number;
}

/**
 * Snapshot consistente do banco. Devolve null quando falha — backup nunca
 * derruba o servico, so avisa.
 */
export function runBackup(reason: string): BackupResult | null {
  const dir = backupDir();
  try {
    mkdirSync(dir, { recursive: true });
    // VACUUM INTO recusa um arquivo que ja existe. O carimbo tem precisao de
    // segundo, entao dois backups no mesmo segundo — boot mais um disparo
    // manual — colidiriam; o sufixo evita transformar isso em erro.
    let name = `${PREFIX}${stamp()}${SUFFIX}`;
    for (let n = 2; existsSync(join(dir, name)); n++) {
      name = `${PREFIX}${stamp()}-${n}${SUFFIX}`;
    }
    const path = join(dir, name);
    // Parametro em vez de interpolar: o caminho no Windows tem barra invertida
    // e aspas simples do SQLite nao perdoam.
    database.prepare('VACUUM INTO ?').run(path);
    const { size } = statSync(path);
    const kept = prune();
    console.log(`[backup] ${path} (${Math.round(size / 1024)} kB, motivo=${reason}, mantidos=${kept})`);
    recordAudit({
      actor: 'system',
      actorAccountId: null,
      ip: '',
      action: 'system.backup',
      detail: { arquivo: name, kb: Math.round(size / 1024), motivo: reason },
    });
    return { path, bytes: size };
  } catch (error) {
    console.error('[backup] falhou:', error instanceof Error ? error.message : error);
    return null;
  }
}

/** Apaga os mais antigos e devolve quantos sobraram. */
function prune(): number {
  const keep = Math.max(Number(process.env['VOX_BACKUP_KEEP']) || 14, 1);
  const dir = backupDir();
  const files = readdirSync(dir)
    .filter((name) => name.startsWith(PREFIX) && name.endsWith(SUFFIX))
    .sort();
  for (const name of files.slice(0, Math.max(files.length - keep, 0))) {
    try {
      unlinkSync(join(dir, name));
    } catch {
      // Arquivo em uso ou ja removido nao invalida o backup recem-criado.
    }
  }
  return Math.min(files.length, keep);
}

/**
 * Agenda os backups e devolve como parar. `VOX_BACKUP_INTERVAL_HOURS=0`
 * desliga tudo, para quem prefere cuidar disso por fora.
 */
export function startBackups(): () => void {
  const hours = Number(process.env['VOX_BACKUP_INTERVAL_HOURS'] ?? 24);
  if (!Number.isFinite(hours) || hours <= 0) {
    console.log('[backup] desligado (VOX_BACKUP_INTERVAL_HOURS=0)');
    return () => undefined;
  }

  // Um snapshot logo depois do boot fixa o estado anterior ao deploy, que e
  // exatamente o que se quer restaurar quando uma atualizacao da errado.
  const boot = setTimeout(() => runBackup('boot'), BOOT_DELAY_MS);
  boot.unref();

  const timer = setInterval(() => runBackup('agendado'), hours * 60 * 60_000);
  timer.unref();
  console.log(`[backup] a cada ${hours}h em ${backupDir()}`);

  return () => {
    clearTimeout(boot);
    clearInterval(timer);
  };
}
