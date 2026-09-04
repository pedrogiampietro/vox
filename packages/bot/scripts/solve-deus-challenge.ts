/**
 * Bootstrap de sessao autorizada em uma janela visivel.
 *
 * O scraper resolve o challenge sozinho; este comando existe para o caso em
 * que ele nao consegue — captcha de imagem, IP recem-bloqueado ou um perfil
 * que precisa nascer com a verificacao ja feita. A janela usa o mesmo solver
 * do service, entao normalmente ela se resolve sozinha e so resta olhar; se
 * pedir interacao, resolva na tela.
 *
 * O navegador deve sair pelo mesmo IP que o service usa. Em uma maquina local,
 * use um SOCKS5 criado por `ssh -D` para a VPS e, depois, copie o storage-state
 * gerado para o diretorio do service.
 */

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPersistentContext } from 'cloakbrowser';
import type { Page } from 'playwright-core';
import { isChallenge, pageSnapshot, solveChallenge } from '../src/scrapers/challenge.js';
import { scraperBrowserArgs } from '../src/scrapers/browser.js';

type Provider = 'deusot' | 'deusold';

const BASE_URL: Record<Provider, string> = {
  deusot: 'https://deusot.com',
  deusold: 'https://deusold.com',
};

const DEFAULT_PATH = '/community/worlds';
const TIMEOUT_MS = 45_000;
/** Na janela visivel o humano pode ajudar, entao damos mais folga que no service. */
const CHALLENGE_TIMEOUT_MS = 180_000;
const PROJECT_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const PROFILE_ROOT = process.env['VOX_SCRAPER_PROFILE_DIR']?.trim()
  || resolve(PROJECT_ROOT, 'data', 'scraper-profiles');

function providerArg(): Provider {
  const value = process.argv[2]?.trim().toLowerCase() || 'deusot';
  if (value === 'deusot' || value === 'deusold') return value;
  throw new Error('provider invalido; use "deusot" ou "deusold"');
}

/** Abre a rota e so volta quando ela estiver liberada. */
async function open(page: Page, url: string, provider: Provider, path: string): Promise<void> {
  await page.goto(`${url}${path}`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  const snapshot = await pageSnapshot(page);
  if (!isChallenge(snapshot)) {
    console.log(`[challenge] ${provider}: ${path} liberado`);
    return;
  }
  await solveChallenge(page, {
    label: provider,
    path,
    timeoutMs: CHALLENGE_TIMEOUT_MS,
    attempts: 5,
    interactive: true,
    headless: false,
  });
}

async function main(): Promise<void> {
  const provider = providerArg();
  const baseUrl = BASE_URL[provider];
  const serviceProfile = resolve(PROFILE_ROOT, provider);
  const manualProfile = resolve(serviceProfile, 'manual-browser');
  const storageStatePath = resolve(serviceProfile, 'storage-state.json');
  const proxy = process.env['VOX_CHALLENGE_PROXY']?.trim();

  await mkdir(serviceProfile, { recursive: true });
  console.log(`[challenge] abrindo ${baseUrl}${DEFAULT_PATH}`);
  console.log('[challenge] o solver tenta sozinho; se sobrar captcha, resolva na janela');
  if (proxy) console.log(`[challenge] proxy SOCKS/HTTP: ${proxy.replace(/:[^:/]+@/, ':***@')}`);

  const context = await launchPersistentContext({
    userDataDir: manualProfile,
    headless: false,
    args: scraperBrowserArgs(),
    ...(proxy ? { proxy } : {}),
  });
  const page = context.pages()[0] ?? await context.newPage();

  try {
    await open(page, baseUrl, provider, DEFAULT_PATH);
    // Confirma que o clearance funciona em uma segunda rota antes de salvar.
    await open(page, baseUrl, provider, '/community/deaths');

    await context.storageState({ path: storageStatePath });
    console.log(`[challenge] sessao salva em ${storageStatePath}`);
    console.log('[challenge] agora copie esse arquivo para a mesma pasta na VPS e reinicie vox.service');
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
