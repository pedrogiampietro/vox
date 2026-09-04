/**
 * Operacoes de ciclo de vida do bot compartilhadas entre o painel admin e as
 * chamadas de owner vindas do cliente. Mantidas aqui para nao duplicar
 * `new RubinotBot(...)`, restart e stop em dois lugares.
 *
 * De qual OT os dados vem sai do preset ativo do servidor — ver providerFor.
 */

import { RubinotBot } from '../../bot/src/bot.js';
import { deusotProvider } from '../../bot/src/scrapers/deusot.js';
import { deusoldProvider } from '../../bot/src/scrapers/deusold.js';
import { rubinotProvider } from '../../bot/src/scrapers/rubinot.js';
import type { BotProvider } from '@vox/protocol';
import type { GameProvider } from '../../bot/src/scrapers/provider.js';
import type { Hub } from './hub.js';
import type { StoredBotConfig } from './persistence.js';

/**
 * Fonte de dados do preset ativo. Presets com `provider: 'none'` nao tem API
 * conhecida; nesses o bot nao deveria estar ligado, mas se estiver caimos no
 * Rubinot em vez de derrubar o servidor.
 */
export function providerFor(hub: Hub): GameProvider {
  switch (hub.activePreset().bot.provider) {
    case 'deusot': return deusotProvider;
    case 'deusold': return deusoldProvider;
    default: return rubinotProvider;
  }
}

/** Identidade exibida no painel, inclusive para presets sem bot. */
export function providerInfoFor(hub: Hub): { id: BotProvider; label: string } {
  const id = hub.activePreset().bot.provider;
  return id === 'none' ? { id, label: 'Sem bot' } : { id, label: providerFor(hub).label };
}

/**
 * Garante que a mesma guild nao aparece em friendGuilds e enemyGuilds.
 * Intencao explicita mais recente (enemyGuilds) vence sobre migracao legada.
 * Roda antes de restart, para o bot nao carregar sync ambigua.
 */
function sanitizeGuildLists(hub: Hub): void {
  const c = hub.botConfig;
  const enemyKeys = new Set(c.enemyGuilds.map((g) => g.toLowerCase()));
  const before = c.friendGuilds.length;
  c.friendGuilds = c.friendGuilds.filter((g) => !enemyKeys.has(g.toLowerCase()));
  if (c.friendGuilds.length !== before) {
    console.log(
      `[bot] limpou ${before - c.friendGuilds.length} guild(s) duplicadas de friendGuilds`,
    );
  }
}

/** Recria/atualiza o bot para refletir a config atual do hub. */
export function applyBotConfig(hub: Hub): void {
  sanitizeGuildLists(hub);
  if (hub.rubinot) {
    const cfg = { ...hub.botConfig, huntedNames: hub.rubinot.huntedList };
    void hub.rubinot.restart(cfg);
    return;
  }
  if (hub.botConfig.enabled && hub.botConfig.world) {
    const bot = new RubinotBot(hub, hub.botConfig, providerFor(hub));
    hub.rubinot = bot;
    void bot.start().catch((err) => console.error('[bot] falha:', err));
  }
}

export function startBot(hub: Hub): string | null {
  const provider = hub.activePreset().bot.provider;
  if (provider === 'none') return 'este preset não possui um provider de bot';
  if (!hub.botConfig.world.trim()) return `informe o world do ${providerFor(hub).label} antes de ligar o bot`;
  hub.botConfig.enabled = true;
  if (!hub.rubinot) hub.rubinot = new RubinotBot(hub, hub.botConfig, providerFor(hub));
  if (!hub.rubinot.isRunning) {
    void hub.rubinot.start().catch((err) => console.error('[bot] falha:', err));
  }
  return null;
}

/** Inicia aguardando a primeira sincronização, usado pelo painel REST. */
export async function startBotAndWait(hub: Hub): Promise<string | null> {
  const provider = hub.activePreset().bot.provider;
  if (provider === 'none') return 'este preset não possui um provider de bot';
  if (!hub.botConfig.world.trim()) return `informe o world do ${providerFor(hub).label} antes de ligar o bot`;

  hub.botConfig.enabled = true;
  if (!hub.rubinot) hub.rubinot = new RubinotBot(hub, hub.botConfig, providerFor(hub));
  if (hub.rubinot.isRunning) return null;

  try {
    await hub.rubinot.start();
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[bot] falha ao iniciar ${providerFor(hub).label}:`, message);
    return `não foi possível iniciar o bot ${providerFor(hub).label}: ${message}`;
  }
}

export function stopBot(hub: Hub): void {
  hub.botConfig.enabled = false;
  hub.rubinot?.stop();
}

/** Publica um alerta de teste no canal do bot. */
export function testBot(hub: Hub): void {
  const provider = providerFor(hub);
  const channelId = hub.ensureChannel(hub.botConfig.channelName || 'bot');
  const message = `[test] alerta de teste do ${provider.label}`;
  hub.channelAnnounce(channelId, provider.id, message);
  hub.serverChannelAnnounce(channelId, provider.id, message);
}

export function currentBotConfig(hub: Hub): StoredBotConfig {
  return { ...hub.botConfig, huntedNames: hub.rubinot?.huntedList ?? hub.botConfig.huntedNames };
}
