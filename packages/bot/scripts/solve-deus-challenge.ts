/**
 * Abre uma sessao visivel para resolver manualmente um challenge autorizado.
 *
 * O navegador deve sair pelo mesmo IP que o service usa. Em uma maquina local,
 * use um SOCKS5 criado por `ssh -D` para a VPS e, depois, copie o storage-state
 * gerado para o diretorio do service.
 */

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launchPersistentContext } from 'cloakbrowser';
import type { Page } from 'playwright-core';
import { scraperProfileDir } from '../src/scrapers/browser.js';

type Provider = 'deusot' | 'deusold';

const BASE_URL: Record<Provider, string> = {
  deusot: 'https://deusot.com',
  deusold: 'https://deusold.com',
};

const DEFAULT_PATH = '/community/worlds';
const TIMEOUT_MS = 45_000;
const POLL_MS = 750;

function providerArg(): Provider {
  const value = process.argv[2]?.trim().toLowerCase() || 'deusot';
  if (value === 'deusot' || value === 'deusold') return value;
  throw new Error('provider invalido; use "deusot" ou "deusold"');
}

function challengeDetected(title: string, html: string): boolean {
  const page = `${title}\n${html}`.toLowerCase();
  return (
    page.includes('just a moment')
    || page.includes('attention required')
    || page.includes('security verification')
    || page.includes('verify you are human')
    || page.includes('cf-chl-')
    || page.includes('checking your browser')
    || page.includes('performing security verification')
  );
}

async function waitForClear(page: Page, provider: Provider): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastState = '';
  while (Date.now() < deadline) {
    const title = await page.title().catch(() => '');
    const html = await page.content().catch(() => '');
    const state = challengeDetected(title, html) ? 'challenge' : 'liberado';
    if (state !== lastState) {
      console.log(`[challenge] ${provider}: ${state}`);
      lastState = state;
    }
    if (state === 'liberado') return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_MS));
  }
  throw new Error(
    `${provider}: o challenge nao foi liberado em ${TIMEOUT_MS / 1000}s; ` +
      'resolva-o na janela aberta e tente novamente',
  );
}

async function main(): Promise<void> {
  const provider = providerArg();
  const baseUrl = BASE_URL[provider];
  const serviceProfile = scraperProfileDir(provider);
  const manualProfile = resolve(serviceProfile, 'manual-browser');
  const storageStatePath = resolve(serviceProfile, 'storage-state.json');
  const proxy = process.env['VOX_CHALLENGE_PROXY']?.trim();

  await mkdir(serviceProfile, { recursive: true });
  console.log(`[challenge] abrindo ${baseUrl}${DEFAULT_PATH}`);
  console.log('[challenge] resolva a verificacao manualmente na janela do navegador');
  if (proxy) console.log(`[challenge] proxy SOCKS/HTTP: ${proxy.replace(/:[^:/]+@/, ':***@')}`);

  const context = await launchPersistentContext(manualProfile, {
    headless: false,
    ...(proxy ? { proxy } : {}),
  });
  const page = context.pages()[0] ?? await context.newPage();

  try {
    await page.goto(`${baseUrl}${DEFAULT_PATH}`, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUT_MS,
    });
    await waitForClear(page, provider);

    // Confirma que o clearance funciona em uma segunda rota antes de salvar.
    await page.goto(`${baseUrl}/community/deaths`, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUT_MS,
    });
    await waitForClear(page, provider);

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
