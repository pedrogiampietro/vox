/**
 * Deteccao e resolucao ativa do challenge do Cloudflare.
 *
 * O interstitial tem dois modos. O nao-interativo termina sozinho quando o
 * JavaScript da pagina acaba de rodar — era o unico que o scraper resolvia,
 * porque ele so esperava. O modo gerenciado (Turnstile) monta um widget com a
 * caixa "Verify you are human" e nunca libera sem um clique; era esse que
 * batia no timeout e derrubava o provider.
 *
 * Aqui procuramos o widget — o iframe de challenges.cloudflare.com, o checkbox
 * dentro dele ou o container que o hospeda na pagina — e clicamos. O clique
 * sai do driver de input do Chromium, com as curvas de mouse humanizadas do
 * cloakbrowser, entao chega na pagina como evento real (isTrusted). Nao
 * forjamos token, nao injetamos evento sintetico e nao resolvemos captcha de
 * imagem: se o site pedir mais que o checkbox, a tentativa falha e o erro sobe
 * como antes.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { humanMove, resolveConfig } from 'cloakbrowser/human';
import type { Frame, Page } from 'playwright-core';

/** Janela dada ao modo nao-interativo antes do primeiro clique. */
const FIRST_AUTO_WAIT_MS = 8_000;
/** Janelas seguintes: o token ja rodou uma vez, nao vale esperar tanto. */
const AUTO_WAIT_MS = 4_000;
/** Tempo que o Cloudflare leva para validar o clique e redirecionar. */
const CLICK_WAIT_MS = 12_000;
const POLL_MS = 500;
const RELOAD_TIMEOUT_MS = 25_000;

/** Curvas de mouse conservadoras: o widget mede pixels, nao velocidade. */
const HUMAN = resolveConfig('careful');

const CF_FRAME = /challenges\.cloudflare\.com/i;

/**
 * Containers do widget na pagina principal, na ordem em que o Cloudflare os
 * usa. Servem de alvo quando o iframe ainda nao existe ou esta escondido em
 * shadow DOM fechado — o clique por coordenada acerta o mesmo pixel.
 */
const WIDGET_SELECTORS = [
  '#challenge-stage',
  '#cf-challenge-stage',
  '.cf-turnstile',
  '#turnstile-wrapper',
  '[id^="cf-chl-widget"]',
  'div[class*="turnstile"]',
];

/** Distancia da borda esquerda do widget ate o centro do checkbox. */
const CHECKBOX_INSET_PX = 30;

export interface PageSnapshot {
  title: string;
  html: string;
}

interface Point {
  x: number;
  y: number;
}

interface Box extends Point {
  width: number;
  height: number;
}

export function challengeDelay(ms: number): Promise<void> {
  // setTimeout nativo de proposito: page.waitForTimeout() fala CDP, e o
  // proprio Cloudflare pontua esse trafego.
  return new Promise((done) => setTimeout(done, ms));
}

export function challengeTitle(title: string): boolean {
  const lower = title.toLowerCase();
  return (
    lower.includes('just a moment')
    || lower.includes('attention required')
    || lower.includes('security verification')
    || lower.includes('verify you are human')
  );
}

export function challengeBody(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    lower.includes('cf-chl-')
    || lower.includes('checking your browser')
    || lower.includes('performing security verification')
    || lower.includes('verify you are human')
  );
}

export function isChallenge(snapshot: PageSnapshot): boolean {
  return challengeTitle(snapshot.title) || challengeBody(snapshot.html);
}

/**
 * `domcontentloaded` pode ser emitido antes de um redirect/interstitial
 * terminar. Ler content() nesse intervalo gera o erro intermitente
 * "page is navigating and changing the content", entao insistimos por alguns
 * segundos antes de desistir.
 */
export async function pageSnapshot(page: Page): Promise<PageSnapshot> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return { title: await page.title(), html: await page.content() };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/page is navigating|changing the content/i.test(message)) throw error;
      await challengeDelay(250);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('pagina nao estabilizou depois da navegacao');
}

// ------------------------------------------------------------------ alvo --

/**
 * Caixa de um seletor, em coordenadas da viewport principal — o Playwright ja
 * soma o deslocamento do iframe. Elementos invisiveis ou de area zero nao
 * servem de alvo e voltam como null.
 */
async function boxOf(frame: Frame, selector: string): Promise<Box | null> {
  try {
    const locator = frame.locator(selector).first();
    if (await locator.count() === 0) return null;
    const box = await locator.boundingBox({ timeout: 1_000 });
    if (!box || box.width <= 0 || box.height <= 0) return null;
    return box;
  } catch {
    return null;
  }
}

/** Ponto do checkbox a partir da caixa do widget inteiro. */
function checkboxPoint(box: Box): Point {
  return {
    x: box.x + Math.min(CHECKBOX_INSET_PX, box.width / 2),
    y: box.y + box.height / 2,
  };
}

/**
 * Onde clicar. O iframe do Turnstile aparece em page.frames() mesmo quando o
 * elemento esta dentro de um shadow root fechado, entao ele e a primeira
 * escolha; o container na pagina e o plano B.
 */
export async function locateWidget(page: Page): Promise<Point | null> {
  const frame = page.frames().find((candidate) => CF_FRAME.test(candidate.url()));
  if (frame) {
    // O checkbox e o alvo exato quando o documento do widget esta acessivel.
    const checkbox = await boxOf(frame, 'input[type="checkbox"]');
    if (checkbox) {
      return { x: checkbox.x + checkbox.width / 2, y: checkbox.y + checkbox.height / 2 };
    }

    // Sem acesso ao interior, miramos a coluna da esquerda do proprio iframe,
    // que e onde o Turnstile desenha a caixa de marcar.
    try {
      const element = await frame.frameElement();
      const box = await element.boundingBox();
      if (box && box.width > 0 && box.height > 0) return checkboxPoint(box);
    } catch {
      // Frame desanexado no meio da medicao; caimos nos seletores da pagina.
    }
  }

  for (const selector of WIDGET_SELECTORS) {
    const box = await boxOf(page.mainFrame(), selector);
    if (box) return checkboxPoint(box);
  }
  return null;
}

/**
 * Clique real: curva de mouse ate o alvo, pausa de mira e um down/up com
 * duracao humana. Erros aqui sao esperados quando o Cloudflare redireciona no
 * meio do movimento — quem chama trata como tentativa perdida.
 */
async function humanClickAt(page: Page, cursor: Point, target: Point): Promise<void> {
  await humanMove(page.mouse, cursor.x, cursor.y, target.x, target.y, HUMAN);
  cursor.x = target.x;
  cursor.y = target.y;
  await challengeDelay(120 + Math.random() * 180);
  await page.mouse.down();
  await challengeDelay(60 + Math.random() * 90);
  await page.mouse.up();
}

/** Poll ate a pagina deixar de ser challenge, ou ate a janela acabar. */
async function waitForClear(
  page: Page,
  budgetMs: number,
  signal?: AbortSignal,
): Promise<PageSnapshot | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    signal?.throwIfAborted();
    const snapshot = await pageSnapshot(page);
    if (!isChallenge(snapshot)) return snapshot;
    if (Date.now() >= deadline) return null;
    await challengeDelay(POLL_MS);
  }
}

/**
 * Screenshot + HTML do estado que nao liberou. E a unica forma pratica de
 * saber, depois do fato, se o site pediu captcha de imagem, bloqueou o IP ou
 * se apenas nao encontramos o widget.
 */
async function dumpDebug(page: Page, dir: string, label: string): Promise<string | null> {
  try {
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = resolve(dir, `${label.toLowerCase()}-${stamp}`);
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    await writeFile(`${base}.html`, await page.content(), 'utf8');
    return base;
  } catch {
    return null;
  }
}

export interface ChallengeContext {
  /** Nome do provider nos logs. */
  label: string;
  /** Rota que disparou o challenge, usada na mensagem de erro. */
  path: string;
  /** Orcamento total, somando esperas e cliques. */
  timeoutMs: number;
  /** Quantas rodadas de (esperar -> clicar -> recarregar) tentar. */
  attempts: number;
  /** false volta ao comportamento antigo: so esperar. */
  interactive: boolean;
  /** So para a dica de diagnostico quando a resolucao falha. */
  headless: boolean;
  debugDir?: string | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Resolve o challenge da pagina atual e devolve o snapshot ja liberado. Lanca
 * quando o orcamento acaba — a mensagem continua sendo a que a documentacao de
 * operacao cita, com o resumo das tentativas no fim.
 */
export async function solveChallenge(page: Page, ctx: ChallengeContext): Promise<PageSnapshot> {
  const deadline = Date.now() + ctx.timeoutMs;
  const cursor: Point = { x: 60 + Math.random() * 120, y: 80 + Math.random() * 120 };
  let attempt = 0;
  let clicks = 0;
  let widgetSeen = false;

  console.log(`[challenge] ${ctx.label}: interstitial em ${ctx.path}; resolvendo`);

  for (;;) {
    ctx.signal?.throwIfAborted();

    // O modo nao-interativo se resolve sozinho; damos essa janela antes de
    // tocar na pagina, porque clicar cedo demais reinicia o widget.
    const autoWait = attempt === 0 ? FIRST_AUTO_WAIT_MS : AUTO_WAIT_MS;
    const cleared = await waitForClear(
      page,
      Math.min(autoWait, Math.max(0, deadline - Date.now())),
      ctx.signal,
    );
    if (cleared) {
      console.log(`[challenge] ${ctx.label}: liberado (cliques=${clicks})`);
      return cleared;
    }
    if (Date.now() >= deadline) break;

    if (ctx.interactive) {
      const target = await locateWidget(page);
      if (target) {
        widgetSeen = true;
        clicks++;
        const at = `${Math.round(target.x)},${Math.round(target.y)}`;
        console.log(`[challenge] ${ctx.label}: clique ${clicks} no widget (${at})`);
        try {
          await humanClickAt(page, cursor, target);
        } catch (error) {
          // Redirect no meio do movimento e sinal de progresso, nao de falha.
          const message = error instanceof Error ? error.message : String(error);
          console.log(`[challenge] ${ctx.label}: clique interrompido (${message})`);
        }
        const after = await waitForClear(
          page,
          Math.min(CLICK_WAIT_MS, Math.max(0, deadline - Date.now())),
          ctx.signal,
        );
        if (after) {
          console.log(`[challenge] ${ctx.label}: liberado (cliques=${clicks})`);
          return after;
        }
      }
    }

    attempt++;
    if (attempt >= ctx.attempts || Date.now() >= deadline) break;

    // Token novo: um challenge ja recusado nao volta a valer nesta pagina.
    console.log(
      `[challenge] ${ctx.label}: recarregando para um token novo (${attempt}/${ctx.attempts})`,
    );
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: RELOAD_TIMEOUT_MS });
    } catch {
      // Sem reload seguimos com a pagina que esta ali; o proximo poll decide.
    }
  }

  const dump = ctx.debugDir ? await dumpDebug(page, ctx.debugDir, ctx.label) : null;
  const detail = [
    `tentativas=${attempt || 1}`,
    `cliques=${clicks}`,
    widgetSeen ? 'widget=encontrado' : 'widget=nao encontrado',
    `headless=${ctx.headless}`,
  ].join(' ');
  const hint = ctx.headless
    ? '; challenge gerenciado costuma exigir VOX_SCRAPER_HEADLESS=false (use xvfb-run na VPS)'
    : '';
  throw new Error(
    `${ctx.label} recebeu um challenge que nao foi concluido automaticamente em ${ctx.path}; `
      + 'a sessao autorizada pode ter expirado ou estar vinculada a outro IP/perfil '
      + `(${detail})${hint}${dump ? `; dump em ${dump}.png` : ''}`,
  );
}
