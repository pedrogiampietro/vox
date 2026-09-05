/**
 * Gerencia processos do jukebox de musica — um por servidor virtual.
 *
 * Quando o servidor inicia ou um novo Hub e criado, spawna automaticamente
 * uma instancia do music-jukebox apontando para `/vox/{id}`. Se o processo
 * morrer ele reinicia sozinho depois de 3s.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { config } from './config.js';

const RESTART_DELAY_MS = 3_000;
const JUKEBOX_SCRIPT = resolve(process.cwd(), 'packages/bot/src/music-jukebox.ts');

interface JukeboxEntry {
  child: ChildProcess;
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
}

const active = new Map<number, JukeboxEntry>();
let tsxBin = '';

function getTsx(): string {
  if (tsxBin) return tsxBin;
  const local = join(process.cwd(), 'node_modules', '.bin', 'tsx');
  tsxBin = existsSync(local) ? local : 'tsx';
  return tsxBin;
}

export function spawnJukebox(serverId: number): void {
  if (active.has(serverId)) return;

  const address = `ws://127.0.0.1:${config.port}/vox/${serverId}`;
  const child = spawn(getTsx(), [JUKEBOX_SCRIPT], {
    env: { ...process.env, VOX_BOT_ADDRESS: address },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  const entry: JukeboxEntry = { child, timer: null, stopped: false };
  active.set(serverId, entry);

  console.log(`[jukebox] servidor ${serverId}: processo iniciado (pid ${child.pid})`);

  child.on('exit', (code) => {
    console.log(`[jukebox] servidor ${serverId}: processo encerrou (code ${code})`);
    active.delete(serverId);
    if (!entry.stopped) {
      entry.timer = setTimeout(() => spawnJukebox(serverId), RESTART_DELAY_MS);
      entry.timer.unref();
    }
  });

  child.on('error', (err) => {
    console.error(`[jukebox] servidor ${serverId}: erro ao spawnar: ${err.message}`);
    active.delete(serverId);
    if (!entry.stopped) {
      entry.timer = setTimeout(() => spawnJukebox(serverId), RESTART_DELAY_MS);
      entry.timer.unref();
    }
  });
}

export function stopJukebox(serverId: number): void {
  const entry = active.get(serverId);
  if (!entry) return;
  entry.stopped = true;
  if (entry.timer) clearTimeout(entry.timer);
  entry.child.kill('SIGTERM');
  active.delete(serverId);
  console.log(`[jukebox] servidor ${serverId}: processo parado`);
}

export function spawnAllJukeboxes(serverIds: number[]): void {
  for (const id of serverIds) spawnJukebox(id);
}

export function stopAllJukeboxes(): void {
  for (const id of [...active.keys()]) stopJukebox(id);
}
