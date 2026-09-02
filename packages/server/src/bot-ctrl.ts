/**
 * Operacoes de ciclo de vida do bot Rubinot compartilhadas entre o painel
 * admin e as chamadas de owner vindas do cliente. Mantidas aqui para nao
 * duplicar `new RubinotBot(...)`, restart e stop em dois lugares.
 */

import { RubinotBot } from '../../bot/src/bot.js';
import type { Hub } from './hub.js';
import type { StoredBotConfig } from './persistence.js';

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
    const bot = new RubinotBot(hub, hub.botConfig);
    hub.rubinot = bot;
    void bot.start().catch((err) => console.error('[bot] falha:', err));
  }
}

export function startBot(hub: Hub): void {
  hub.botConfig.enabled = true;
  if (!hub.rubinot) hub.rubinot = new RubinotBot(hub, hub.botConfig);
  if (!hub.rubinot.isRunning) {
    void hub.rubinot.start().catch((err) => console.error('[bot] falha:', err));
  }
}

export function stopBot(hub: Hub): void {
  hub.botConfig.enabled = false;
  hub.rubinot?.stop();
}

/** Publica um alerta de teste no canal do bot. */
export function testBot(hub: Hub): void {
  const channelId = hub.ensureChannel(hub.botConfig.channelName || 'bot');
  hub.channelAnnounce(channelId, 'rubinot', '[test] alerta de teste do Rubinot');
  hub.serverChannelAnnounce(channelId, 'rubinot', '[test] alerta de teste do Rubinot');
}

export function currentBotConfig(hub: Hub): StoredBotConfig {
  return { ...hub.botConfig, huntedNames: hub.rubinot?.huntedList ?? hub.botConfig.huntedNames };
}
