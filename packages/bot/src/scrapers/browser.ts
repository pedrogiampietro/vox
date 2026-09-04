/**
 * Sessao de navegador usada pelos scrapers que precisam executar JavaScript.
 *
 * Cada provider roda em um perfil de usuario proprio e persistente: cookies,
 * localStorage e os tokens de dispositivo do Cloudflare sobrevivem ao restart,
 * e DeusOT e DeusOld nunca compartilham o mesmo perfil. E um perfil de verdade,
 * nao uma janela anonima — o modo anonimo e detectavel e fazia o clearance
 * salvo no bootstrap manual valer menos do que devia.
 *
 * As navegacoes sao serializadas porque cada provider e um singleton usado por
 * varios servidores Vox. Quando o Cloudflare responde com um interstitial, a
 * resolucao fica em `challenge.ts`.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launchPersistentContext } from 'cloakbrowser';
import type { BrowserContext, Cookie, Page } from 'playwright-core';
import { isChallenge, pageSnapshot, solveChallenge } from './challenge.js';

const NAVIGATION_TIMEOUT_MS = 25_000;
const DEFAULT_CHALLENGE_WAIT_MS = 45_000;
const DEFAULT_CHALLENGE_ATTEMPTS = 3;
const PROFILE_ROOT = process.env['VOX_SCRAPER_PROFILE_DIR'] || resolve('data', 'scraper-profiles');
const DEFAULT_FINGERPRINT = '51873';
/** Exportar o storage-state e backup/transporte, nao persistencia: nao vale um write por request. */
const STATE_EXPORT_INTERVAL_MS = 5 * 60_000;

/** Contextos vivos, para o shutdown do processo fechar o que sobrou. */
const openContexts = new Set<BrowserContext>();

function envBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const CHALLENGE_WAIT_MS = positiveEnv(
  'VOX_SCRAPER_CHALLENGE_WAIT_MS',
  DEFAULT_CHALLENGE_WAIT_MS,
);

function abortError(): Error {
  const error = new Error('scraper abortado');
  error.name = 'AbortError';
  return error;
}

/** Um lock simples sem dependencia externa. */
class AsyncLock {
  private tail = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Caminho compartilhado pelos comandos de operacao e pelo service. */
export function scraperProfileDir(id: string): string {
  return resolve(PROFILE_ROOT, id);
}

/**
 * O clearance do site pode ser associado a sinais do browser. O seed fixo
 * permite que a sessao resolvida no bootstrap seja reutilizada apos restart.
 */
export function scraperBrowserArgs(): string[] {
  const configured = process.env['VOX_SCRAPER_FINGERPRINT']?.trim();
  const fingerprint = configured && /^\d+$/.test(configured)
    ? configured
    : DEFAULT_FINGERPRINT;
  return [`--fingerprint=${fingerprint}`];
}

export function scraperHeadless(): boolean {
  return envBoolean('VOX_SCRAPER_HEADLESS', true);
}

/** Fecha qualquer contexto que ainda esteja aberto no fim do processo. */
export async function closeBrowserRuntime(): Promise<void> {
  const contexts = [...openContexts];
  openContexts.clear();
  await Promise.all(contexts.map((context) => context.close().catch(() => undefined)));
}

export interface BrowserHtmlOptions {
  id: string;
  label: string;
  baseUrl: string;
}

export class PersistentBrowserHtml {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly lock = new AsyncLock();
  private readonly profileDir: string;
  private readonly userDataDir: string;
  private readonly storageStatePath: string;
  private readonly seedMarkerPath: string;
  private lastStateExport = 0;

  constructor(private readonly options: BrowserHtmlOptions) {
    this.profileDir = scraperProfileDir(options.id);
    this.userDataDir = resolve(this.profileDir, 'profile');
    this.storageStatePath = resolve(this.profileDir, 'storage-state.json');
    this.seedMarkerPath = resolve(this.profileDir, '.storage-state-seeded');
  }

  async get(path: string, signal?: AbortSignal): Promise<string> {
    return this.lock.run(async () => {
      signal?.throwIfAborted();
      const page = await this.ensurePage();
      const url = new URL(path, this.options.baseUrl).toString();

      try {
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: NAVIGATION_TIMEOUT_MS,
        });
      } catch (error) {
        if (signal?.aborted) throw abortError();
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${this.options.label} navegador: falha ao abrir ${path}: ${message}`);
      }

      // Uma interstitial pode terminar depois do primeiro DOMContentLoaded.
      // Paginas normais seguem direto; so o challenge entra no solver.
      let snapshot = await pageSnapshot(page);
      if (isChallenge(snapshot)) {
        snapshot = await solveChallenge(page, {
          label: this.options.label,
          path,
          timeoutMs: CHALLENGE_WAIT_MS,
          attempts: positiveEnv('VOX_SCRAPER_CHALLENGE_ATTEMPTS', DEFAULT_CHALLENGE_ATTEMPTS),
          interactive: envBoolean('VOX_SCRAPER_CHALLENGE_INTERACTIVE', true),
          headless: scraperHeadless(),
          debugDir: process.env['VOX_SCRAPER_CHALLENGE_DEBUG_DIR']?.trim() || undefined,
          signal,
        });
      }

      signal?.throwIfAborted();
      await this.exportState();
      return snapshot.html;
    });
  }

  async close(): Promise<void> {
    await this.lock.run(async () => {
      const context = this.context;
      this.context = null;
      this.page = null;
      if (context) {
        openContexts.delete(context);
        await this.exportState(context, true);
        await context.close();
      }
    });
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;

    if (!this.context) {
      await mkdir(this.userDataDir, { recursive: true });
      const headless = scraperHeadless();
      console.log(
        `[scraper] abrindo perfil: ${this.options.label} (dir=${this.userDataDir} headless=${headless})`,
      );
      this.context = await launchPersistentContext({
        userDataDir: this.userDataDir,
        headless,
        args: scraperBrowserArgs(),
      });
      openContexts.add(this.context);
      this.context.on('close', () => {
        if (this.context) openContexts.delete(this.context);
        this.context = null;
        this.page = null;
      });
      await this.seedCookies();
    }

    this.page = this.context.pages()[0] ?? await this.context.newPage();
    return this.page;
  }

  /**
   * Importa `storage-state.json` (gerado por `npm run solve:deus`) no perfil.
   * Um marcador guarda o mtime ja importado: copiar um arquivo novo para a VPS
   * e reiniciar o service continua sendo suficiente, e um restart comum nao
   * sobrescreve os cookies que o perfil renovou sozinho.
   */
  private async seedCookies(): Promise<void> {
    if (!this.context || !existsSync(this.storageStatePath)) return;
    try {
      const { mtimeMs } = await stat(this.storageStatePath);
      const seeded = Number(await readFile(this.seedMarkerPath, 'utf8').catch(() => '0'));
      if (Number.isFinite(seeded) && mtimeMs <= seeded) return;

      const raw = await readFile(this.storageStatePath, 'utf8');
      const cookies = (JSON.parse(raw) as { cookies?: Cookie[] }).cookies ?? [];
      await writeFile(this.seedMarkerPath, String(mtimeMs), 'utf8');
      if (cookies.length === 0) return;
      await this.context.addCookies(cookies);
      console.log(`[scraper] ${this.options.label}: ${cookies.length} cookies importados do bootstrap`);
    } catch (error) {
      // Sessao invalida nao impede o scraper de tentar resolver o challenge.
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[scraper] ${this.options.label}: storage-state ignorado (${message})`);
    }
  }

  /** Mantem o arquivo exportavel em dia sem escrever a cada request. */
  private async exportState(context = this.context, force = false): Promise<void> {
    if (!context) return;
    if (!force && Date.now() - this.lastStateExport < STATE_EXPORT_INTERVAL_MS) return;
    this.lastStateExport = Date.now();
    try {
      await mkdir(this.profileDir, { recursive: true });
      await context.storageState({ path: this.storageStatePath });
      // O export e mais novo que o perfil por definicao: marcar evita que o
      // proximo boot reimporte os cookies que acabamos de exportar.
      const { mtimeMs } = await stat(this.storageStatePath);
      await writeFile(this.seedMarkerPath, String(mtimeMs), 'utf8');
    } catch {
      // Exportar e conveniencia de operacao; falhar aqui nao invalida a leitura.
    }
  }
}
