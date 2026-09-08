/**
 * API do painel de administracao.
 *
 * JSON sobre HTTP, separado do protocolo binario de propósito: o painel nao
 * precisa de latencia nem de bytes contados, precisa ser facil de inspecionar
 * com o devtools aberto. E ele nunca fala com o Hub por atalho - passa pelos
 * mesmos metodos que a moderacao do cliente usa.
 *
 * Autenticacao e uma senha unica trocada por um token de sessao em memoria.
 * Nada de cookie: o painel guarda o token e manda no Authorization, o que
 * elimina CSRF sem precisar de token anti-CSRF.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { findPreset, Group, RemoveReason } from '@vox/protocol';
import { adminEnabled, config } from './config.js';
import type { Registry } from './registry.js';
import { createAccount, ensureAccount, findAccount, findAccountById, verifyPassword } from './accounts.js';
import type { StoredBotConfig } from './persistence.js';
import { applyBotConfig, currentBotConfig, providerInfoFor, startBotAndWait, stopBot, testBot } from './bot-ctrl.js';
import { addTicketMessage, createTicket, getTicket, listTickets, updateTicketStatus, type TicketStatus } from './tickets.js';
import { list as listAudit, record as recordAudit } from './audit.js';
import {
  BILLING_PERIOD_MS,
  billingPlans,
  createMercadoPagoPreference,
  createOrder,
  findLatestApprovedOrderForServer,
  findOrder,
  getBillingPlan,
  getMercadoPagoPayment,
  listOrders,
  updateOrder,
  validWebhookSignature,
  type BillingOrder,
} from './billing.js';

/** Corpo maior que isto so pode ser abuso: o painel manda objetos minusculos. */
const MAX_BODY_BYTES = 16 * 1024;

interface RateRule {
  limit: number;
  windowMs: number;
}

/**
 * Tetos por janela deslizante. A chave e a conta quando ha sessao e o IP
 * quando nao ha — atras de um proxy sem VOX_TRUST_PROXY todo mundo compartilha
 * o mesmo IP, e limitar por conta evita que um cliente derrube os outros.
 *
 * Os numeros sao folgados de proposito: o objetivo e cortar script, nao
 * atrapalhar quem clica rapido no painel.
 */
const RATE: Record<string, RateRule> = {
  /** Login e registro: o unico ponto onde adivinhar senha compensa. */
  auth: { limit: 8, windowMs: 5 * 60_000 },
  /** Qualquer escrita autenticada. */
  write: { limit: 120, windowMs: 60_000 },
  /** Cria servidor de verdade; sem teto, uma conta enche a VPS de graca. */
  provision: { limit: 3, windowMs: 60 * 60_000 },
  /** Gera pedido e fala com o Mercado Pago. */
  checkout: { limit: 10, windowMs: 60 * 60_000 },
  /** Abrir e responder chamado. */
  ticket: { limit: 12, windowMs: 10 * 60_000 },
  /** Rota publica: o Mercado Pago repete, mas nao em rajada. */
  webhook: { limit: 120, windowMs: 60_000 },
};

interface Hits {
  count: number;
  windowStart: number;
}

/** Registrador ja amarrado a sessao e ao IP; ver AdminApi.auditor. */
type Audit = (action: string, serverId: number | null, detail?: Record<string, unknown>) => void;

export class AdminApi {
  /** Token -> expiracao. Em memoria: reiniciar o servidor desloga o painel. */
  private readonly tokens = new Map<string, { expires: number; ownerId: number | null }>();
  /** `balde:chave` -> janela corrente. Ver RATE. */
  private readonly hits = new Map<string, Hits>();
  /** Evita provisionar duas vezes quando o Mercado Pago repete em paralelo. */
  private readonly processingOrders = new Set<string>();
  /** Conexoes SSE abertas, para empurrar o estado ao vivo. */
  private readonly streams = new Map<ServerResponse, number | null>();

  constructor(private readonly registry: Registry) {}

  /** Empurra o estado atual para todo painel aberto. */
  broadcastState(): void {
    if (this.streams.size === 0) return;
    // Cada assinante recebe o recorte da propria conta; o master ve tudo.
    for (const [res, ownerId] of this.streams) {
      const payloadData = ownerId === null
        ? this.overview()
        : this.overview({ ownerId });
      const payload = `data: ${JSON.stringify(payloadData)}\n\n`;
      try {
        res.write(payload);
      } catch {
        this.streams.delete(res);
      }
    }
  }

  /** Retorna true quando a requisicao era da API e ja foi respondida. */
  handle(req: IncomingMessage, res: ServerResponse, path: string, ip: string): boolean {
    if (!path.startsWith('/api/')) return false;

    const publicBillingRoute = path === '/api/billing/plans'
      || path === '/api/payments/mercadopago/webhook';
    if (!adminEnabled && !publicBillingRoute) {
      send(res, 503, { error: 'painel desligado: defina VOX_ADMIN_PASSWORD' });
      return true;
    }

    void this.route(req, res, path, ip).catch((err) => {
      console.error('[vox] erro na API do painel:', err);
      if (!res.headersSent) send(res, 500, { error: 'erro interno' });
    });
    return true;
  }

  private async route(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    ip: string,
  ): Promise<void> {
    const method = req.method ?? 'GET';

    if (path === '/api/billing/plans' && method === 'GET') {
      return send(res, 200, { plans: billingPlans(), checkout: billingPlans().some((plan) => plan.enabled) });
    }
    if (path === '/api/payments/mercadopago/webhook' && method === 'POST') {
      if (!this.allow('webhook', `ip:${ip}`)) return send(res, 429, { error: 'muitas notificações' });
      return this.mercadoPagoWebhook(req, res, ip);
    }

    if (path === '/api/login' && method === 'POST') {
      return this.login(req, res, ip);
    }
    if (path === '/api/account/login' && method === 'POST') {
      return this.accountLogin(req, res, ip);
    }
    if (path === '/api/account/register' && method === 'POST') {
      return this.accountRegister(req, res, ip);
    }

    const session = this.authorized(req);
    if (!session) {
      send(res, 401, { error: 'nao autenticado' });
      return;
    }

    // Teto unico para toda escrita autenticada; rotas caras somam o proprio
    // balde adiante. Leitura fica livre: o painel faz polling legitimo.
    if (method !== 'GET' && !this.allow('write', this.rateKey(session, ip))) {
      return send(res, 429, { error: 'muitas requisições; aguarde alguns segundos' });
    }
    const audit = this.auditor(session, ip);

    if (path === '/api/account/me' && method === 'GET') {
      const account = session.ownerId === null ? undefined : findAccountById(session.ownerId);
      return account
        ? send(res, 200, { id: account.id, email: account.email, createdAt: account.createdAt, role: 'owner' })
        : send(res, 403, { error: 'sessao sem conta de cliente' });
    }

    if (path === '/api/overview' && method === 'GET') {
      return send(res, 200, this.overview(session));
    }

    // Visao geral da trilha. O master ve tudo; o dono ve apenas o que ele
    // proprio fez, inclusive o que nao pertence a um servidor (login, compra).
    if (path === '/api/audit' && method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const before = Number(url.searchParams.get('before'));
      return send(res, 200, {
        entries: listAudit({
          ...(session.ownerId === null ? {} : { accountId: session.ownerId }),
          limit: Number(url.searchParams.get('limit')) || 100,
          ...(Number.isInteger(before) && before > 0 ? { before } : {}),
        }),
      });
    }

    if (path === '/api/tickets' && method === 'GET') {
      return send(res, 200, { tickets: listTickets(session.ownerId) });
    }
    if (path === '/api/tickets' && method === 'POST') {
      if (!this.allow('ticket', this.rateKey(session, ip))) {
        return send(res, 429, { error: 'muitos chamados em pouco tempo; aguarde alguns minutos' });
      }
      return this.createSupportTicket(req, res, session);
    }

    const ticketMatch = /^\/api\/tickets\/([a-z0-9-]+)(?:\/(reply|status))?$/.exec(path);
    if (ticketMatch && method === 'POST' && ticketMatch[2] === 'reply') {
      if (!this.allow('ticket', this.rateKey(session, ip))) {
        return send(res, 429, { error: 'muitas respostas em pouco tempo; aguarde alguns minutos' });
      }
      return this.replySupportTicket(req, res, session, ticketMatch[1]!);
    }
    if (ticketMatch && method === 'PATCH' && ticketMatch[2] === 'status') {
      return this.changeSupportTicketStatus(req, res, session, ticketMatch[1]!, audit);
    }

    if (path === '/api/account/provision' && method === 'POST') {
      // Servidor comunidade e gratuito: sem teto, uma conta so provisiona ate
      // encher o disco da VPS.
      if (!this.allow('provision', this.rateKey(session, ip))) {
        return send(res, 429, { error: 'limite de criação de servidores atingido; tente novamente mais tarde' });
      }
      return this.provisionAccountServer(req, res, session, audit);
    }

    if (path === '/api/account/checkout' && method === 'POST') {
      if (!this.allow('checkout', this.rateKey(session, ip))) {
        return send(res, 429, { error: 'muitas tentativas de compra; aguarde alguns minutos' });
      }
      return this.createAccountCheckout(req, res, session, audit);
    }

    const renewalMatch = /^\/api\/account\/servers\/(\d+)\/renew$/.exec(path);
    if (renewalMatch && method === 'POST') {
      if (!this.allow('checkout', this.rateKey(session, ip))) {
        return send(res, 429, { error: 'muitas tentativas de renovação; aguarde alguns minutos' });
      }
      return this.createAccountRenewal(res, session, Number(renewalMatch[1]), audit);
    }

    const orderMatch = /^\/api\/account\/orders\/([a-z0-9-]+)$/.exec(path);
    if (orderMatch && method === 'GET') {
      return this.accountOrder(res, session, orderMatch[1]!);
    }

    if (path === '/api/stream' && method === 'GET') {
      return this.stream(req, res, session);
    }

    if (path === '/api/accounts' && method === 'POST') {
      if (session.ownerId !== null) return send(res, 403, { error: 'somente o master pode criar contas' });
      const body = await readJson(req);
      const account = ensureAccount(str(body.email), str(body.password));
      return account
        ? send(res, 201, { id: account.id, email: account.email })
        : send(res, 409, { error: 'email existente, senha incorreta ou senha muito curta (minimo 8 caracteres)' });
    }

    if (path === '/api/servers' && method === 'POST') {
      const body = await readJson(req);
      const hub = this.registry.create({
        name: str(body.name),
        slug: str(body.slug),
        ownerId: int(body.ownerId, 0) || null,
        motd: str(body.motd),
        password: str(body.password),
        maxClients: int(body.maxClients, 128),
      });
      audit('server.create', hub.id, { slug: hub.settings.slug, name: hub.settings.name });
      this.broadcastState();
      return send(res, 201, { id: hub.id, slug: hub.settings.slug, url: publicUrl(hub.settings.slug) });
    }

    const match = /^\/api\/servers\/(\d+)(\/[a-z-]+)?(?:\/(.+))?$/.exec(path);
    if (!match) return send(res, 404, { error: 'rota desconhecida' });

    const hub = this.registry.get(Number(match[1]));
    if (!hub) return send(res, 404, { error: 'servidor inexistente' });
    if (session.ownerId !== null && hub.settings.ownerId !== session.ownerId) {
      return send(res, 404, { error: 'servidor inexistente' });
    }
    const action = match[2] ?? '';
    const rest = match[3] ?? '';

    // ---- servidor ----------------------------------------------------------

    if (action === '' && method === 'GET') {
      const provider = providerInfoFor(hub);
      return send(res, 200, {
        ...hub.settings,
        url: publicUrl(hub.settings.slug),
        presetId: hub.activePreset().id,
        provider: provider.id,
        providerLabel: provider.label,
        password: hub.settings.password ? '(definida)' : '',
        channels: hub.channelList,
        clients: hub.clientList(),
        bans: hub.banList(),
        groups: hub.groupList(),
      });
    }

    if (action === '' && method === 'PATCH') {
      const body = await readJson(req);
      const requestedPreset = body.presetId === undefined ? '' : str(body.presetId).trim();
      if (requestedPreset && !findPreset(requestedPreset)) {
        return send(res, 400, { error: 'preset desconhecido' });
      }
      const update = {
        ...(body.slug !== undefined ? { slug: str(body.slug) } : {}),
        ...(body.name !== undefined ? { name: str(body.name) } : {}),
        ...(body.motd !== undefined ? { motd: str(body.motd) } : {}),
        ...(body.password !== undefined ? { password: str(body.password) } : {}),
        ...(session.ownerId === null && body.maxClients !== undefined
          ? { maxClients: int(body.maxClients, 128) }
          : {}),
      };
      const updated = this.registry.update(hub.id, {
        ...update,
      });
      if (!updated) return send(res, 409, { error: 'slug invalido ou ja utilizado' });
      if (requestedPreset && !hub.setBuiltinPresetFromAdmin(requestedPreset)) {
        return send(res, 400, { error: 'preset desconhecido' });
      }
      // Senha nunca entra no registro: o valor exato nao ajuda a auditar, e o
      // log passaria a ser um alvo.
      audit('server.update', hub.id, {
        campos: Object.keys(update),
        ...(requestedPreset ? { preset: requestedPreset } : {}),
      });
      this.broadcastState();
      return send(res, 200, { ok: true });
    }

    if (action === '' && method === 'DELETE') {
      const slug = hub.settings.slug;
      const removed = this.registry.remove(hub.id);
      if (removed) audit('server.delete', hub.id, { slug });
      this.broadcastState();
      return removed
        ? send(res, 200, { ok: true })
        : send(res, 409, { error: 'o ultimo servidor nao pode ser removido' });
    }

    // ---- moderacao ---------------------------------------------------------

    if (action === '/kick' && method === 'POST') {
      const body = await readJson(req);
      const target = hub.sessionById(int(body.clientId, 0));
      if (!target) return send(res, 404, { error: 'usuario nao esta online' });
      const reason = str(body.reason) || 'expulso pelo painel';
      hub.expel(target, RemoveReason.Kicked, reason);
      audit('client.kick', hub.id, { alvo: target.nickname, motivo: reason });
      this.broadcastState();
      return send(res, 200, { ok: true });
    }

    if (action === '/ban' && method === 'POST') {
      const body = await readJson(req);
      const target = hub.sessionById(int(body.clientId, 0));
      if (!target) return send(res, 404, { error: 'usuario nao esta online' });
      const minutes = int(body.minutes, 0);
      const reason = str(body.reason) || 'banido pelo painel';
      hub.banSession(target, minutes, reason);
      audit('client.ban', hub.id, { alvo: target.nickname, minutos: minutes, motivo: reason });
      this.broadcastState();
      return send(res, 200, { ok: true });
    }

    if (action === '/bans' && method === 'DELETE') {
      const ok = hub.removeBan(rest);
      if (ok) audit('ban.remove', hub.id, { banimento: rest });
      this.broadcastState();
      return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'banimento inexistente' });
    }

    if (action === '/move' && method === 'POST') {
      const body = await readJson(req);
      const target = hub.sessionById(int(body.clientId, 0));
      if (!target) return send(res, 404, { error: 'usuario nao esta online' });
      const channelId = int(body.channelId, 0);
      hub.forceMove(target, channelId);
      audit('client.move', hub.id, { alvo: target.nickname, canal: channelId });
      this.broadcastState();
      return send(res, 200, { ok: true });
    }

    if (action === '/group' && method === 'POST') {
      const body = await readJson(req);
      const group = int(body.group, Group.Guest);
      if (group < Group.Guest || group > Group.Dono) {
        return send(res, 400, { error: 'grupo invalido' });
      }
      const fingerprint = str(body.fingerprint);
      hub.setGroupByFingerprint(fingerprint, group as Group);
      audit('client.group', hub.id, { fingerprint: fingerprint.slice(0, 16), grupo: group });
      this.broadcastState();
      return send(res, 200, { ok: true });
    }

    if (action === '/announce' && method === 'POST') {
      const body = await readJson(req);
      const text = str(body.text);
      if (!text) return send(res, 400, { error: 'texto vazio' });
      hub.announce(text);
      audit('server.announce', hub.id, { texto: text.slice(0, 120) });
      return send(res, 200, { ok: true });
    }

    // ---- bot ---------------------------------------------------------------

    if (action === '/bot' && method === 'GET') {
      const provider = providerInfoFor(hub);
      const botConfig = currentBotConfig(hub);
      return send(res, 200, {
        provider: provider.id,
        providerLabel: provider.label,
        config: botConfig,
        running: hub.rubinot?.isRunning ?? false,
        starting: hub.rubinot?.isStarting ?? false,
        error: hub.rubinot?.lastStartError ?? '',
        hunted: hub.rubinot?.manualHuntedList ?? hub.botConfig.huntedNames,
        friends: hub.rubinot?.friendsList ?? [],
        friendGuilds: [...hub.botConfig.friendGuilds],
        enemyGuilds: [...hub.botConfig.enemyGuilds],
      });
    }

    if (action === '/bot' && method === 'PATCH') {
      const body = await readJson(req);
      const bc = hub.botConfig;
      if (body.world !== undefined) bc.world = str(body.world);
      if (body.guildName !== undefined) bc.guildName = str(body.guildName);
      if (body.channelName !== undefined) bc.channelName = str(body.channelName) || 'bot';
      if (body.intervalMs !== undefined) bc.intervalMs = Math.max(int(body.intervalMs, 60_000), 10_000);
      if (body.enabled !== undefined) bc.enabled = !!body.enabled;
      if (body.globalDeaths !== undefined) bc.globalDeaths = !!body.globalDeaths;
      if (body.globalKills !== undefined) bc.globalKills = !!body.globalKills;
      if (body.globalLevelMin !== undefined) bc.globalLevelMin = Math.max(int(body.globalLevelMin, 800), 0);
      if (body.summarizePresence !== undefined) bc.summarizePresence = !!body.summarizePresence;
      if (body.presenceSummaryMs !== undefined) {
        bc.presenceSummaryMs = Math.max(int(body.presenceSummaryMs, 5 * 60_000), 60_000);
      }
      if (body.alertEnemyDeath !== undefined) bc.alertEnemyDeath = !!body.alertEnemyDeath;
      if (body.alertFriendDeath !== undefined) bc.alertFriendDeath = !!body.alertFriendDeath;
      if (body.alertFriendLevelUp !== undefined) bc.alertFriendLevelUp = !!body.alertFriendLevelUp;
      if (body.alertEnemyLevelUp !== undefined) bc.alertEnemyLevelUp = !!body.alertEnemyLevelUp;
      if (body.alertEnemyOnline !== undefined) bc.alertEnemyOnline = !!body.alertEnemyOnline;
      if (body.alertEnemyOffline !== undefined) bc.alertEnemyOffline = !!body.alertEnemyOffline;
      hub.botConfig = bc;
      this.registry.scheduleSave();
      try {
        await applyBotConfig(hub);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[bot] falha ao aplicar configuração no servidor ${hub.id}:`, message);
        hub.broadcastBotState();
        return send(res, 502, { error: `não foi possível aplicar a configuração do bot: ${message}` });
      }
      hub.broadcastBotState();
      audit('bot.config', hub.id, { mundo: bc.world, ligado: bc.enabled, intervaloMs: bc.intervalMs });

      this.broadcastState();
      return send(res, 200, { ok: true });
    }

    if (action === '/bot' && rest === 'start' && method === 'POST') {
      const error = await startBotAndWait(hub);
      this.registry.scheduleSave();
      hub.broadcastBotState();
      audit('bot.start', hub.id, error ? { erro: error } : { mundo: hub.botConfig.world });
      if (error) return send(res, 502, { error });
      return send(res, 200, { ok: true });
    }

    if (action === '/bot' && rest === 'stop' && method === 'POST') {
      stopBot(hub);
      this.registry.scheduleSave();
      hub.broadcastBotState();
      audit('bot.stop', hub.id, {});
      return send(res, 200, { ok: true });
    }

    if (action === '/bot' && rest === 'test' && method === 'POST') {
      testBot(hub);
      audit('bot.test', hub.id, {});
      hub.broadcastBotState();
      this.broadcastState();
      return send(res, 200, { ok: true });
    }

    if (action === '/bot' && rest === 'restart' && method === 'POST') {
      try {
        await applyBotConfig(hub);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[bot] falha ao reiniciar no servidor ${hub.id}:`, message);
        hub.broadcastBotState();
        return send(res, 502, { error: `não foi possível iniciar o bot: ${message}` });
      }
      this.registry.scheduleSave();
      hub.broadcastBotState();
      audit('bot.restart', hub.id, { mundo: hub.botConfig.world });
      return send(res, 200, { ok: true });
    }

    if (action === '/bot' && rest === 'guilds/friend' && method === 'POST') {
      const body = await readJson(req);
      const name = str(body.name).trim();
      if (!name) return send(res, 400, { error: 'nome da guild vazio' });
      const key = name.toLowerCase();
      const enemyBefore = hub.botConfig.enemyGuilds.length;
      const friendBefore = hub.botConfig.friendGuilds.length;
      hub.botConfig.enemyGuilds = hub.botConfig.enemyGuilds.filter((guild) => guild.toLowerCase() !== key);
      if (!hub.botConfig.friendGuilds.some((guild) => guild.toLowerCase() === key)) {
        hub.botConfig.friendGuilds.push(name);
      }
      if (enemyBefore !== hub.botConfig.enemyGuilds.length || friendBefore !== hub.botConfig.friendGuilds.length) {
        try {
          await applyBotConfig(hub);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return send(res, 502, { error: `não foi possível sincronizar a guild amiga: ${message}` });
        }
      }
      this.registry.scheduleSave();
      hub.broadcastBotState();
      return send(res, 200, { ok: true });
    }

    if (action === '/bot' && rest === 'guilds/enemy' && method === 'POST') {
      const body = await readJson(req);
      const name = str(body.name).trim();
      if (!name) return send(res, 400, { error: 'nome da guild vazio' });
      const key = name.toLowerCase();
      const friendBefore = hub.botConfig.friendGuilds.length;
      const enemyBefore = hub.botConfig.enemyGuilds.length;
      hub.botConfig.friendGuilds = hub.botConfig.friendGuilds.filter((guild) => guild.toLowerCase() !== key);
      if (!hub.botConfig.enemyGuilds.some((guild) => guild.toLowerCase() === key)) {
        hub.botConfig.enemyGuilds.push(name);
      }
      if (friendBefore !== hub.botConfig.friendGuilds.length || enemyBefore !== hub.botConfig.enemyGuilds.length) {
        try {
          await applyBotConfig(hub);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return send(res, 502, { error: `não foi possível sincronizar a guild inimiga: ${message}` });
        }
      }
      this.registry.scheduleSave();
      hub.broadcastBotState();
      return send(res, 200, { ok: true });
    }

    if (action === '/bot' && rest.startsWith('guilds/friend/') && method === 'DELETE') {
      const name = decodeURIComponent(rest.slice('guilds/friend/'.length)).trim();
      if (!name) return send(res, 400, { error: 'nome da guild vazio' });
      hub.botConfig.friendGuilds = hub.botConfig.friendGuilds.filter(
        (guild) => guild.toLowerCase() !== name.toLowerCase(),
      );
      try {
        await applyBotConfig(hub);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return send(res, 502, { error: `não foi possível atualizar as guilds amigas: ${message}` });
      }
      this.registry.scheduleSave();
      hub.broadcastBotState();
      return send(res, 200, { ok: true });
    }

    if (action === '/bot' && rest.startsWith('guilds/enemy/') && method === 'DELETE') {
      const name = decodeURIComponent(rest.slice('guilds/enemy/'.length)).trim();
      if (!name) return send(res, 400, { error: 'nome da guild vazio' });
      hub.botConfig.enemyGuilds = hub.botConfig.enemyGuilds.filter(
        (guild) => guild.toLowerCase() !== name.toLowerCase(),
      );
      try {
        await applyBotConfig(hub);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return send(res, 502, { error: `não foi possível atualizar as guilds inimigas: ${message}` });
      }
      this.registry.scheduleSave();
      hub.broadcastBotState();
      return send(res, 200, { ok: true });
    }

    if (action === '/bot' && rest === 'hunted' && method === 'POST') {
      const body = await readJson(req);
      const name = str(body.name).trim();
      if (!name) return send(res, 400, { error: 'nome vazio' });
      if (hub.rubinot) {
        hub.rubinot.addHunted(name);
      } else {
        if (!hub.botConfig.huntedNames.some((n) => n.toLowerCase() === name.toLowerCase())) {
          hub.botConfig.huntedNames.push(name);
        }
      }
      this.registry.scheduleSave();
      hub.broadcastBotState();
      return send(res, 200, { ok: true });
    }

    if (action === '/bot' && rest === 'hunted' && method === 'DELETE') {
      if (hub.rubinot) {
        hub.rubinot.clearHunted();
      } else {
        hub.botConfig.huntedNames = [];
      }
      this.registry.scheduleSave();
      hub.broadcastBotState();
      return send(res, 200, { ok: true });
    }

    if (action === '/bot' && rest.startsWith('hunted/') && method === 'DELETE') {
      const name = decodeURIComponent(rest.slice('hunted/'.length)).trim();
      if (!name) return send(res, 400, { error: 'nome vazio' });
      if (hub.rubinot) {
        hub.rubinot.removeHunted(name);
      } else {
        hub.botConfig.huntedNames = hub.botConfig.huntedNames.filter(
          (n) => n.toLowerCase() !== name.toLowerCase(),
        );
      }
      this.registry.scheduleSave();
      hub.broadcastBotState();
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'rota desconhecida' });
  }

  // ------------------------------------------------------------ sessao --

  private async login(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    if (!this.allow('auth', `ip:${ip}`)) {
      return send(res, 429, { error: 'muitas tentativas; aguarde alguns minutos' });
    }
    const body = await readJson(req);
    if (!matches(str(body.password), config.adminPassword)) {
      // Tentativa contra a senha master e a que mais interessa auditar.
      recordAudit({ actor: 'anon', actorAccountId: null, ip, action: 'auth.master.fail' });
      return send(res, 401, { error: 'senha incorreta' });
    }
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, { expires: Date.now() + config.adminSessionMs, ownerId: null });
    this.pruneTokens();
    recordAudit({ actor: 'master', actorAccountId: null, ip, action: 'auth.master.ok' });
    send(res, 200, { token, role: 'master', expiresIn: config.adminSessionMs });
  }

  private async accountLogin(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    if (!this.allow('auth', `ip:${ip}`)) return send(res, 429, { error: 'muitas tentativas; aguarde alguns minutos' });
    const body = await readJson(req);
    const email = str(body.email);
    const account = findAccount(email);
    if (!account || !verifyPassword(account, str(body.password))) {
      recordAudit({
        actor: 'anon',
        actorAccountId: account?.id ?? null,
        ip,
        action: 'auth.account.fail',
        detail: { email: email.trim().toLowerCase() },
      });
      return send(res, 401, { error: 'email ou senha incorretos' });
    }
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, { expires: Date.now() + config.adminSessionMs, ownerId: account.id });
    this.pruneTokens();
    recordAudit({ actor: 'owner', actorAccountId: account.id, ip, action: 'auth.account.ok' });
    send(res, 200, { token, role: 'owner', expiresIn: config.adminSessionMs, account: publicAccount(account) });
  }

  private async accountRegister(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    if (!this.allow('auth', `ip:${ip}`)) return send(res, 429, { error: 'muitas tentativas; aguarde alguns minutos' });
    const body = await readJson(req);
    const email = str(body.email).trim().toLowerCase();
    const password = str(body.password);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return send(res, 400, { error: 'informe um email valido' });
    }
    if (password.length < 8) {
      return send(res, 400, { error: 'a senha precisa ter no minimo 8 caracteres' });
    }
    const account = createAccount(email, password);
    if (!account) return send(res, 409, { error: 'este email ja esta cadastrado' });
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, { expires: Date.now() + config.adminSessionMs, ownerId: account.id });
    this.pruneTokens();
    recordAudit({ actor: 'owner', actorAccountId: account.id, ip, action: 'account.register', detail: { email } });
    send(res, 201, { token, role: 'owner', expiresIn: config.adminSessionMs, account: publicAccount(account) });
  }

  private async provisionAccountServer(
    req: IncomingMessage,
    res: ServerResponse,
    session: { ownerId: number | null },
    audit: Audit,
  ): Promise<void> {
    if (session.ownerId === null) return send(res, 403, { error: 'somente contas de cliente podem contratar' });
    const body = await readJson(req);
    const plan = str(body.plan).trim().toLowerCase();
    if (plan !== 'community') {
      return send(res, 402, { error: 'este plano precisa passar pelo checkout do Mercado Pago antes da criação' });
    }
    const name = str(body.name).trim() || 'Meu servidor Vox';
    const slug = str(body.slug).trim().toLowerCase();
    const password = str(body.password);
    const hub = this.registry.create({
      name,
      slug,
      ownerId: session.ownerId,
      password,
      maxClients: 10,
      motd: 'Bem-vindo ao seu servidor Vox.',
      presetId: 'rubinot',
    });
    audit('account.provision', hub.id, { plano: plan, slug: hub.settings.slug });
    this.broadcastState();
    return send(res, 201, {
      plan,
      server: {
        id: hub.id,
        slug: hub.settings.slug,
        name: hub.settings.name,
        maxClients: hub.settings.maxClients,
        url: publicUrl(hub.settings.slug),
      },
      adminUrl: `/painel?server=${hub.id}`,
    });
  }

  private async createAccountCheckout(
    req: IncomingMessage,
    res: ServerResponse,
    session: { ownerId: number | null },
    audit: Audit,
  ): Promise<void> {
    if (session.ownerId === null) return send(res, 403, { error: 'somente contas de cliente podem contratar' });
    const body = await readJson(req);
    const plan = getBillingPlan(str(body.plan).trim().toLowerCase());
    if (!plan) return send(res, 400, { error: 'plano pago inválido' });
    if (!plan.enabled) {
      return send(res, 503, { error: 'este plano ainda não está disponível para contratação' });
    }
    const name = str(body.name).trim() || 'Meu servidor Vox';
    const slug = str(body.slug).trim().toLowerCase();
    const password = str(body.password);
    const account = findAccountById(session.ownerId);
    if (!account) return send(res, 403, { error: 'conta inexistente' });
    const order = createOrder({
      accountId: session.ownerId,
      plan: plan.key,
      amountCents: plan.priceCents,
      serverName: name,
      serverSlug: slug,
      serverPassword: password,
    });
    audit('account.checkout', null, { pedido: order.id, plano: plan.key, centavos: order.amountCents });
    try {
      const preference = await createMercadoPagoPreference(order, account.email);
      return send(res, 201, {
        orderId: order.id,
        status: order.status,
        amountCents: order.amountCents,
        initPoint: preference.initPoint,
      });
    } catch (error) {
      updateOrder(order.id, { status: 'failed', lastError: error instanceof Error ? error.message : 'erro ao criar preferência' });
      return send(res, 502, { error: error instanceof Error ? error.message : 'não foi possível iniciar o pagamento' });
    }
  }

  private async createAccountRenewal(
    res: ServerResponse,
    session: { ownerId: number | null },
    serverId: number,
    audit: Audit,
  ): Promise<void> {
    if (session.ownerId === null) return send(res, 403, { error: 'somente contas de cliente podem renovar' });
    const hub = this.registry.get(serverId);
    if (!hub || hub.settings.ownerId !== session.ownerId) {
      return send(res, 404, { error: 'servidor inexistente' });
    }
    const previous = findLatestApprovedOrderForServer(session.ownerId, serverId);
    if (!previous) return send(res, 400, { error: 'este servidor ainda não possui uma contratação paga' });
    const plan = getBillingPlan(previous.plan);
    if (!plan || !plan.enabled) return send(res, 503, { error: 'este plano ainda não está disponível para renovação' });
    const account = findAccountById(session.ownerId);
    if (!account) return send(res, 403, { error: 'conta inexistente' });
    const order = createOrder({
      accountId: session.ownerId,
      plan: plan.key,
      kind: 'renewal',
      amountCents: plan.priceCents,
      serverName: hub.settings.name,
      serverSlug: hub.settings.slug,
      serverPassword: hub.settings.password,
      serverId,
    });
    audit('account.renew', serverId, { pedido: order.id, plano: plan.key, centavos: order.amountCents });
    try {
      const preference = await createMercadoPagoPreference(order, account.email);
      return send(res, 201, {
        orderId: order.id,
        kind: order.kind,
        status: order.status,
        amountCents: order.amountCents,
        initPoint: preference.initPoint,
      });
    } catch (error) {
      updateOrder(order.id, { status: 'failed', lastError: error instanceof Error ? error.message : 'erro ao criar preferência' });
      return send(res, 502, { error: error instanceof Error ? error.message : 'não foi possível iniciar a renovação' });
    }
  }

  private accountOrder(res: ServerResponse, session: { ownerId: number | null }, id: string): void {
    if (session.ownerId === null) return void send(res, 403, { error: 'somente contas de cliente podem consultar pedidos' });
    const order = findOrder(id);
    if (!order || order.accountId !== session.ownerId) return void send(res, 404, { error: 'pedido inexistente' });
    return void send(res, 200, publicOrder(order, this.registry));
  }

  private async createSupportTicket(
    req: IncomingMessage,
    res: ServerResponse,
    session: { ownerId: number | null },
  ): Promise<void> {
    if (session.ownerId === null) return send(res, 403, { error: 'somente contas de cliente podem abrir tickets' });
    const body = await readJson(req);
    const subject = str(body.subject).trim().slice(0, 120);
    const message = str(body.message).trim().slice(0, 4000);
    if (subject.length < 3) return send(res, 400, { error: 'informe um assunto com pelo menos 3 caracteres' });
    if (message.length < 3) return send(res, 400, { error: 'descreva o problema com pelo menos 3 caracteres' });

    const requestedServerId = Number(body.serverId);
    const serverId = Number.isInteger(requestedServerId) && requestedServerId > 0 ? requestedServerId : null;
    if (serverId !== null) {
      const hub = this.registry.get(serverId);
      if (!hub || hub.settings.ownerId !== session.ownerId) {
        return send(res, 404, { error: 'servidor inexistente' });
      }
    }
    return send(res, 201, { ticket: createTicket({ accountId: session.ownerId, serverId, subject, body: message }) });
  }

  private async replySupportTicket(
    req: IncomingMessage,
    res: ServerResponse,
    session: { ownerId: number | null },
    id: string,
  ): Promise<void> {
    const ticket = getTicket(id);
    if (!ticket || (session.ownerId !== null && ticket.accountId !== session.ownerId)) {
      return send(res, 404, { error: 'ticket inexistente' });
    }
    if (ticket.status === 'closed') return send(res, 409, { error: 'este ticket está fechado' });
    const body = await readJson(req);
    const message = str(body.message).trim().slice(0, 4000);
    if (message.length < 3) return send(res, 400, { error: 'mensagem muito curta' });
    const updated = addTicketMessage(
      id,
      session.ownerId === null ? 'master' : 'owner',
      session.ownerId,
      message,
    );
    return updated
      ? send(res, 200, { ticket: updated })
      : send(res, 404, { error: 'ticket inexistente' });
  }

  private async changeSupportTicketStatus(
    req: IncomingMessage,
    res: ServerResponse,
    session: { ownerId: number | null },
    id: string,
    audit: Audit,
  ): Promise<void> {
    const ticket = getTicket(id);
    if (!ticket || (session.ownerId !== null && ticket.accountId !== session.ownerId)) {
      return send(res, 404, { error: 'ticket inexistente' });
    }
    const body = await readJson(req);
    const status = str(body.status) as TicketStatus;
    if (!['open', 'waiting', 'resolved', 'closed'].includes(status)) {
      return send(res, 400, { error: 'status de ticket inválido' });
    }
    // O cliente pode encerrar o próprio chamado; reabrir ou resolver é ação do
    // suporte master, para não esconder um problema ainda não atendido.
    if (session.ownerId !== null && status !== 'closed') {
      return send(res, 403, { error: 'somente o suporte pode alterar este status' });
    }
    const updated = updateTicketStatus(id, status);
    if (updated) audit('ticket.status', ticket.serverId, { ticket: id, status });
    return updated
      ? send(res, 200, { ticket: updated })
      : send(res, 404, { error: 'ticket inexistente' });
  }

  private async mercadoPagoWebhook(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    if (!config.mpAccessToken || !config.mpWebhookSecret) {
      return send(res, 503, { error: 'webhook Mercado Pago ainda não configurado' });
    }
    const body = await readJson(req);
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
    const data = isObject(body.data) ? body.data : {};
    const dataId = str(data.id) || query.get('data.id') || query.get('data_id') || '';
    const requestId = header(req, 'x-request-id');
    const signature = header(req, 'x-signature');
    if (!dataId || !validWebhookSignature(signature, requestId, dataId)) {
      // Notificacao forjada e o caminho obvio para provisionar sem pagar.
      recordAudit({
        actor: 'anon',
        actorAccountId: null,
        ip,
        action: 'billing.webhook.reject',
        detail: { dataId: dataId.slice(0, 40) },
      });
      return send(res, 401, { error: 'assinatura do webhook inválida' });
    }
    if (str(body.type) !== 'payment' && str(body.topic) !== 'payment') {
      return send(res, 200, { ok: true });
    }

    const payment = await getMercadoPagoPayment(dataId);
    const orderId = payment.external_reference || '';
    const order = orderId ? findOrder(orderId) : undefined;
    if (!order) return send(res, 200, { ok: true });
    if (order.status === 'approved' && order.serverId !== null) return send(res, 200, { ok: true });
    if (this.processingOrders.has(order.id)) return send(res, 200, { ok: true });
    this.processingOrders.add(order.id);
    try {
      const paymentId = String(payment.id ?? dataId);
      const paymentMethodId = payment.payment_method_id ?? '';
      const paymentTypeId = payment.payment_type_id ?? '';
      const statusDetail = payment.status_detail ?? '';
      if (payment.currency_id !== 'BRL' || Math.round(Number(payment.transaction_amount) * 100) !== order.amountCents) {
        updateOrder(order.id, {
          status: 'failed',
          paymentId,
          paymentMethodId,
          paymentTypeId,
          statusDetail,
          lastError: 'valor ou moeda do pagamento não conferem',
        });
        return send(res, 200, { ok: true });
      }
      if (payment.status !== 'approved') {
        const terminal = payment.status === 'rejected' || payment.status === 'cancelled' || payment.status === 'refunded' || payment.status === 'charged_back';
        updateOrder(order.id, {
          status: terminal ? 'failed' : 'pending',
          paymentId,
          paymentMethodId,
          paymentTypeId,
          statusDetail,
          lastError: terminal ? `pagamento ${payment.status}` : '',
        });
        return send(res, 200, { ok: true });
      }
      const paidAt = paymentTimestamp(payment.date_approved) ?? Date.now();
      if (order.kind === 'renewal' && order.serverId !== null) {
        const hub = this.registry.get(order.serverId);
        if (!hub || hub.settings.ownerId !== order.accountId) {
          updateOrder(order.id, {
            status: 'failed',
            paymentId,
            paidAt,
            paymentMethodId,
            paymentTypeId,
            statusDetail,
            lastError: 'servidor da renovação não foi encontrado',
          });
          return send(res, 200, { ok: true });
        }
        const previous = findLatestApprovedOrderForServer(order.accountId, order.serverId);
        const previousExpiry = previous?.expiresAt ?? 0;
        const expiresAt = Math.max(previousExpiry, paidAt) + BILLING_PERIOD_MS;
        updateOrder(order.id, {
          status: 'approved',
          paymentId,
          paidAt,
          expiresAt,
          paymentMethodId,
          paymentTypeId,
          statusDetail,
          lastError: '',
        });
        this.broadcastState();
        recordAudit({
          actor: 'anon',
          actorAccountId: order.accountId,
          ip,
          action: 'billing.renewal.approved',
          serverId: order.serverId,
          detail: { pedido: order.id, plano: order.plan, centavos: order.amountCents },
        });
        console.log(`[vox] renovação aprovada: pedido ${order.id}, servidor ${order.serverId}`);
        return send(res, 200, { ok: true });
      }
      const plan = getBillingPlan(order.plan);
      const hub = this.registry.create({
        name: order.serverName,
        slug: order.serverSlug,
        ownerId: order.accountId,
        password: order.serverPassword,
        maxClients: plan?.slots ?? 10,
        motd: 'Bem-vindo ao seu servidor Vox.',
        presetId: 'rubinot',
      });
      if (plan?.botEnabled) {
        // A configuracao BOT_* da VPS pertence ao servidor principal e nunca
        // deve vazar para um novo cliente. O owner escolhe o world e as guilds
        // no proprio painel; o canal e o preset ja vieram do Registry.
        hub.botConfig = { ...hub.botConfig, enabled: true };
        hub.ensureChannel(hub.botConfig.channelName || 'bot');
        await applyBotConfig(hub);
        this.registry.scheduleSave();
      }
      updateOrder(order.id, {
        status: 'approved',
        paymentId,
        serverId: hub.id,
        paidAt,
        expiresAt: paidAt + BILLING_PERIOD_MS,
        paymentMethodId,
        paymentTypeId,
        statusDetail,
        lastError: '',
      });
      recordAudit({
        actor: 'anon',
        actorAccountId: order.accountId,
        ip,
        action: 'billing.order.approved',
        serverId: hub.id,
        detail: { pedido: order.id, plano: order.plan, centavos: order.amountCents, slug: hub.settings.slug },
      });
      this.broadcastState();
      console.log(`[vox] pagamento aprovado: pedido ${order.id}, servidor ${hub.id}`);
      return send(res, 200, { ok: true });
    } finally {
      this.processingOrders.delete(order.id);
    }
  }

  /**
   * Consome uma unidade do balde. `false` significa estourou a janela — quem
   * chama responde 429 e nao executa a acao.
   */
  private allow(bucket: keyof typeof RATE, key: string): boolean {
    const rule = RATE[bucket]!;
    const now = Date.now();
    const id = `${bucket}:${key}`;
    const entry = this.hits.get(id);
    if (!entry || now - entry.windowStart > rule.windowMs) {
      this.hits.set(id, { count: 1, windowStart: now });
      return true;
    }
    entry.count++;
    return entry.count <= rule.limit;
  }

  /**
   * Registrador ja amarrado a sessao e ao IP da requisicao, para os handlers
   * so precisarem dizer o que aconteceu.
   */
  private auditor(session: { ownerId: number | null }, ip: string) {
    return (action: string, serverId: number | null, detail: Record<string, unknown> = {}): void => {
      recordAudit({
        actor: session.ownerId === null ? 'master' : 'owner',
        actorAccountId: session.ownerId,
        ip,
        action,
        serverId,
        detail,
      });
    };
  }

  /** Sessao autenticada conta por conta; o resto, por IP. */
  private rateKey(session: { ownerId: number | null } | null, ip: string): string {
    if (!session) return `ip:${ip}`;
    return session.ownerId === null ? 'master' : `owner:${session.ownerId}`;
  }

  /** Janelas ja vencidas nao precisam ocupar memoria ate o proximo acesso. */
  private pruneHits(): void {
    const now = Date.now();
    for (const [id, entry] of this.hits) {
      const bucket = id.slice(0, id.indexOf(':')) as keyof typeof RATE;
      const rule = RATE[bucket];
      if (!rule || now - entry.windowStart > rule.windowMs) this.hits.delete(id);
    }
  }

  private authorized(req: IncomingMessage): { ownerId: number | null } | null {
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const query = url.pathname === '/api/stream' ? url.searchParams.get('token') ?? '' : '';
    const token = bearer || query;
    if (!token) return null;
    const session = this.tokens.get(token);
    if (session === undefined) return null;
    if (session.expires < Date.now()) {
      this.tokens.delete(token);
      return null;
    }
    return { ownerId: session.ownerId };
  }

  private pruneTokens(): void {
    const now = Date.now();
    for (const [token, session] of this.tokens) {
      if (session.expires < now) this.tokens.delete(token);
    }
    this.pruneHits();
  }

  // ------------------------------------------------------------ leitura --

  private overview(session: { ownerId: number | null } = { ownerId: null }): unknown {
    const all = this.registry.snapshot();
    const servers = session.ownerId === null
      ? all
      : all.filter((server) => server.ownerId === session.ownerId);
    const account = session.ownerId === null ? undefined : findAccountById(session.ownerId);
    return {
      account: account ? publicAccount(account) : null,
      servers,
      orders: session.ownerId === null
        ? []
        : listOrders(session.ownerId).map((order) => publicOrder(order, this.registry)),
      totals: {
        clients: servers.reduce((total, server) => total + server.clients, 0),
        servers: servers.length,
      },
      role: session.ownerId === null ? 'master' : 'owner',
      stamp: Date.now(),
    };
  }

  /** Server-Sent Events: presenca ao vivo sem inventar outro protocolo. */
  private stream(req: IncomingMessage, res: ServerResponse, session: { ownerId: number | null }): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`data: ${JSON.stringify(this.overview(session))}\n\n`);
    this.streams.set(res, session.ownerId);
    req.on('close', () => this.streams.delete(res));
  }
}

function publicAccount(account: { id: number; email: string; createdAt: number }): { id: number; email: string; createdAt: number } {
  return { id: account.id, email: account.email, createdAt: account.createdAt };
}

function publicOrder(order: BillingOrder, registry: Registry): unknown {
  const hub = order.serverId === null ? undefined : registry.get(order.serverId);
  return {
    id: order.id,
    plan: order.plan,
    kind: order.kind,
    amountCents: order.amountCents,
    status: order.status,
    preferenceId: order.preferenceId,
    paymentId: order.paymentId,
    paidAt: order.paidAt,
    expiresAt: order.expiresAt,
    paymentMethodId: order.paymentMethodId,
    paymentTypeId: order.paymentTypeId,
    statusDetail: order.statusDetail,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    server: hub
      ? {
          id: hub.id,
          slug: hub.settings.slug,
          name: hub.settings.name,
          maxClients: hub.settings.maxClients,
          url: publicUrl(hub.settings.slug),
        }
      : undefined,
    adminUrl: hub ? `/painel?server=${hub.id}` : undefined,
  };
}

function paymentTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) ? stamp : null;
}

// -------------------------------------------------------------- utilidades --

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('corpo grande demais');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Comparacao de tempo constante: senha nao se compara com ===. */
function matches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Ainda assim gasta o mesmo tempo, para nao vazar o tamanho da senha.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function int(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function publicUrl(slug: string): string {
  return `https://${slug}.${config.baseDomain}`;
}
