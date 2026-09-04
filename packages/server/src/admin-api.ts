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
import { Group, RemoveReason } from '@vox/protocol';
import { adminEnabled, config } from './config.js';
import type { Registry } from './registry.js';
import { createAccount, ensureAccount, findAccount, findAccountById, verifyPassword } from './accounts.js';
import type { StoredBotConfig } from './persistence.js';
import { applyBotConfig, startBot, stopBot, testBot } from './bot-ctrl.js';

/** Corpo maior que isto so pode ser abuso: o painel manda objetos minusculos. */
const MAX_BODY_BYTES = 16 * 1024;
/** Tentativas de login por IP, por janela. */
const LOGIN_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;

interface Attempts {
  count: number;
  windowStart: number;
}

export class AdminApi {
  /** Token -> expiracao. Em memoria: reiniciar o servidor desloga o painel. */
  private readonly tokens = new Map<string, { expires: number; ownerId: number | null }>();
  private readonly attempts = new Map<string, Attempts>();
  /** Conexoes SSE abertas, para empurrar o estado ao vivo. */
  private readonly streams = new Map<ServerResponse, number | null>();

  constructor(private readonly registry: Registry) {}

  /** Empurra o estado atual para todo painel aberto. */
  broadcastState(): void {
    if (this.streams.size === 0) return;
    const payload = `data: ${JSON.stringify(this.overview())}\n\n`;
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

    if (!adminEnabled) {
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

    if (path === '/api/account/me' && method === 'GET') {
      const account = session.ownerId === null ? undefined : findAccountById(session.ownerId);
      return account
        ? send(res, 200, { id: account.id, email: account.email, createdAt: account.createdAt, role: 'owner' })
        : send(res, 403, { error: 'sessao sem conta de cliente' });
    }

    if (path === '/api/overview' && method === 'GET') {
      return send(res, 200, this.overview(session));
    }

    if (path === '/api/account/provision' && method === 'POST') {
      return this.provisionAccountServer(req, res, session);
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
      return send(res, 200, {
        ...hub.settings,
        url: publicUrl(hub.settings.slug),
        password: hub.settings.password ? '(definida)' : '',
        channels: hub.channelList,
        clients: hub.clientList(),
        bans: hub.banList(),
        groups: hub.groupList(),
      });
    }

    if (action === '' && method === 'PATCH') {
      const body = await readJson(req);
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
      this.broadcastState();
      return send(res, 200, { ok: true });
    }

    if (action === '' && method === 'DELETE') {
      const removed = this.registry.remove(hub.id);
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
      hub.expel(target, RemoveReason.Kicked, str(body.reason) || 'expulso pelo painel');
      this.broadcastState();
      return send(res, 200, { ok: true });
    }

    if (action === '/ban' && method === 'POST') {
      const body = await readJson(req);
      const target = hub.sessionById(int(body.clientId, 0));
      if (!target) return send(res, 404, { error: 'usuario nao esta online' });
      hub.banSession(target, int(body.minutes, 0), str(body.reason) || 'banido pelo painel');
      this.broadcastState();
      return send(res, 200, { ok: true });
    }

    if (action === '/bans' && method === 'DELETE') {
      const ok = hub.removeBan(rest);
      this.broadcastState();
      return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'banimento inexistente' });
    }

    if (action === '/move' && method === 'POST') {
      const body = await readJson(req);
      const target = hub.sessionById(int(body.clientId, 0));
      if (!target) return send(res, 404, { error: 'usuario nao esta online' });
      hub.forceMove(target, int(body.channelId, 0));
      this.broadcastState();
      return send(res, 200, { ok: true });
    }

    if (action === '/group' && method === 'POST') {
      const body = await readJson(req);
      const group = int(body.group, Group.Guest);
      if (group < Group.Guest || group > Group.Owner) {
        return send(res, 400, { error: 'grupo invalido' });
      }
      hub.setGroupByFingerprint(str(body.fingerprint), group as Group);
      this.broadcastState();
      return send(res, 200, { ok: true });
    }

    if (action === '/announce' && method === 'POST') {
      const body = await readJson(req);
      const text = str(body.text);
      if (!text) return send(res, 400, { error: 'texto vazio' });
      hub.announce(text);
      return send(res, 200, { ok: true });
    }

    // ---- bot ---------------------------------------------------------------

    if (action === '/bot' && method === 'GET') {
      return send(res, 200, {
        config: hub.botConfig,
        running: hub.rubinot?.isRunning ?? false,
        hunted: hub.rubinot?.huntedList ?? hub.botConfig.huntedNames,
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
      applyBotConfig(hub);
      hub.broadcastBotState();

      this.broadcastState();
      return send(res, 200, { ok: true });
    }

    if (action === '/bot' && rest === 'start' && method === 'POST') {
      startBot(hub);
      this.registry.scheduleSave();
      hub.broadcastBotState();
      return send(res, 200, { ok: true });
    }

    if (action === '/bot' && rest === 'stop' && method === 'POST') {
      stopBot(hub);
      this.registry.scheduleSave();
      hub.broadcastBotState();
      return send(res, 200, { ok: true });
    }

    if (action === '/bot' && rest === 'test' && method === 'POST') {
      testBot(hub);
      hub.broadcastBotState();
      this.broadcastState();
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
    if (!this.allowAttempt(ip)) {
      return send(res, 429, { error: 'muitas tentativas; aguarde alguns minutos' });
    }
    const body = await readJson(req);
    if (!matches(str(body.password), config.adminPassword)) {
      return send(res, 401, { error: 'senha incorreta' });
    }
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, { expires: Date.now() + config.adminSessionMs, ownerId: null });
    this.pruneTokens();
    send(res, 200, { token, role: 'master', expiresIn: config.adminSessionMs });
  }

  private async accountLogin(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    if (!this.allowAttempt(ip)) return send(res, 429, { error: 'muitas tentativas; aguarde alguns minutos' });
    const body = await readJson(req);
    const account = findAccount(str(body.email));
    if (!account || !verifyPassword(account, str(body.password))) {
      return send(res, 401, { error: 'email ou senha incorretos' });
    }
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, { expires: Date.now() + config.adminSessionMs, ownerId: account.id });
    this.pruneTokens();
    send(res, 200, { token, role: 'owner', expiresIn: config.adminSessionMs, account: publicAccount(account) });
  }

  private async accountRegister(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    if (!this.allowAttempt(ip)) return send(res, 429, { error: 'muitas tentativas; aguarde alguns minutos' });
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
    send(res, 201, { token, role: 'owner', expiresIn: config.adminSessionMs, account: publicAccount(account) });
  }

  private async provisionAccountServer(
    req: IncomingMessage,
    res: ServerResponse,
    session: { ownerId: number | null },
  ): Promise<void> {
    if (session.ownerId === null) return send(res, 403, { error: 'somente contas de cliente podem contratar' });
    const body = await readJson(req);
    const plan = str(body.plan).trim().toLowerCase();
    if (plan !== 'community') {
      return send(res, 402, { error: 'este plano precisa passar pelo checkout do Mercado Pago antes da criação' });
    }
    const owned = this.registry.snapshot().filter((server) => server.ownerId === session.ownerId);
    if (owned.length > 0) {
      return send(res, 409, { error: 'esta conta já possui um servidor; escolha um plano maior no checkout' });
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
    });
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
      adminUrl: '/admin',
    });
  }

  private allowAttempt(ip: string): boolean {
    const now = Date.now();
    const entry = this.attempts.get(ip);
    if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
      this.attempts.set(ip, { count: 1, windowStart: now });
      return true;
    }
    entry.count++;
    return entry.count <= LOGIN_ATTEMPTS;
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

function int(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function publicUrl(slug: string): string {
  return `https://${slug}.${config.baseDomain}`;
}
