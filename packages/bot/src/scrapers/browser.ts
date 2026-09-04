/**
 * Sessao de navegador usada pelos scrapers que precisam executar JavaScript.
 *
 * O contexto e persistente por provider: cookies e localStorage sobrevivem ao
 * restart, mas DeusOT e DeusOld nunca compartilham o mesmo perfil. As
 * navegacoes sao serializadas porque cada provider e um singleton usado por
 * varios servidores Vox.
 */

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launch } from 'cloakbrowser';
import type { Browser, BrowserContext, Page } from 'playwright-core';

const NAVIGATION_TIMEOUT_MS = 25_000;
const DEFAULT_CHALLENGE_WAIT_MS = 45_000;
const PROFILE_ROOT = process.env['VOX_SCRAPER_PROFILE_DIR'] || resolve('data', 'scraper-profiles');
const DEFAULT_FINGERPRINT = '51873';

let sharedBrowser: Browser | null = null;
let sharedBrowserPromise: Promise<Browser> | null = null;

function envBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const CHALLENGE_WAIT_MS = positiveEnv(
  'VOX_SCRAPER_CHALLENGE_WAIT_MS',
  DEFAULT_CHALLENGE_WAIT_MS,
);

function challengeTitle(title: string): boolean {
  const lower = title.toLowerCase();
  return (
    lower.includes('just a moment')
    || lower.includes('attention required')
    || lower.includes('security verification')
    || lower.includes('verify you are human')
  );
}

function challengeBody(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    lower.includes('cf-chl-')
    || lower.includes('checking your browser')
    || lower.includes('performing security verification')
    || lower.includes('verify you are human')
  );
}

function abortError(): Error {
  const error = new Error('scraper abortado');
  error.name = 'AbortError';
  return error;
}

/**
 * `domcontentloaded` pode ser emitido antes de um redirect/interstitial
 * terminar. Ler content() nesse intervalo gera o erro intermitente
 * "page is navigating and changing the content". Fazemos somente uma
 * pequena espera de estabilidade; nao executamos nem tentamos contornar o
 * challenge.
 */
async function pageSnapshot(page: Page): Promise<{ title: string; html: string }> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return { title: await page.title(), html: await page.content() };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/page is navigating|changing the content/i.test(message)) throw error;
      await delay(250);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('pagina nao estabilizou depois da navegacao');
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

const sharedBrowserLock = new AsyncLock();

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

async function browserRuntime(): Promise<Browser> {
  if (sharedBrowser) return sharedBrowser;
  if (!sharedBrowserPromise) {
    const headless = envBoolean('VOX_SCRAPER_HEADLESS', true);
    sharedBrowserPromise = launch({ headless, args: scraperBrowserArgs() }).then((browser) => {
      sharedBrowser = browser;
      browser.on('disconnected', () => {
        sharedBrowser = null;
        sharedBrowserPromise = null;
      });
      console.log(`[scraper] Chromium compartilhado iniciado (headless=${headless})`);
      return browser;
    });
  }
  return sharedBrowserPromise;
}

export async function closeBrowserRuntime(): Promise<void> {
  await sharedBrowserLock.run(async () => {
    const browser = sharedBrowser;
    sharedBrowser = null;
    sharedBrowserPromise = null;
    if (browser) await browser.close();
  });
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
  private readonly storageStatePath: string;

  constructor(private readonly options: BrowserHtmlOptions) {
    this.profileDir = scraperProfileDir(options.id);
    this.storageStatePath = resolve(this.profileDir, 'storage-state.json');
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
      // Esperamos somente quando a pagina ainda se parece com um challenge;
      // paginas HTML normais seguem sem a espera de networkidle.
      let snapshot = await pageSnapshot(page);
      const challengeDeadline = Date.now() + CHALLENGE_WAIT_MS;
      while (challengeTitle(snapshot.title) || challengeBody(snapshot.html)) {
        signal?.throwIfAborted();
        if (Date.now() >= challengeDeadline) {
          throw new Error(
            `${this.options.label} recebeu um challenge que nao foi concluido automaticamente em ${path}; ` +
              'a sessao autorizada pode ter expirado ou estar vinculada a outro IP/perfil',
          );
        }
        await delay(500);
        snapshot = await pageSnapshot(page);
      }

      signal?.throwIfAborted();
      await this.persistState();
      return snapshot.html;
    });
  }

  async close(): Promise<void> {
    await this.lock.run(async () => {
      const context = this.context;
      this.context = null;
      this.page = null;
      if (context) {
        await this.persistState(context);
        await context.close();
      }
    });
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;

    await mkdir(this.profileDir, { recursive: true });
    if (!this.context) {
      const browser = await browserRuntime();
      const state = existsSync(this.storageStatePath)
        ? { storageState: this.storageStatePath }
        : undefined;
      console.log(`[scraper] abrindo contexto: ${this.options.label} (perfil=${this.profileDir})`);
      this.context = await browser.newContext(state);
      this.context.on('close', () => {
        this.context = null;
        this.page = null;
      });
    }

    this.page = this.context.pages()[0] ?? await this.context.newPage();
    return this.page;
  }

  private async persistState(context = this.context): Promise<void> {
    if (!context) return;
    await mkdir(this.profileDir, { recursive: true });
    await context.storageState({ path: this.storageStatePath });
  }
}
