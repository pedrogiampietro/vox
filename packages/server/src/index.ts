/**
 * Entrada do servidor Vox.
 *
 * Um processo, uma porta: HTTP(S) serve o cliente web e o painel, `/api` e a
 * administracao, `/vox[/id]` faz upgrade para WebSocket, e a mesma porta em UDP
 * atende o WebTransport.
 */

import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import type { VoiceEdge } from '@vox/protocol';
import { adminEnabled, config, tlsEnabled } from './config.js';
import { AdminApi } from './admin-api.js';
import { Registry } from './registry.js';
import { attachWebSocket } from './transport-ws.js';
import { attachEdgeWebSocket } from './edge-relay.js';
import { startVoiceTransport, type VoiceEndpoint } from './transport-wt.js';
import { RubinotBot, botConfigFromEnv } from '../../bot/src/bot.js';
import { shutdownRubinotClient } from '../../bot/src/scrapers/rubinot.js';

// --------------------------------------------------------------- estado --

const registry = new Registry();
const admin = new AdminApi(registry);

// ------------------------------------------------------------- arquivos --

/** Cliente e painel, servidos do mesmo processo quando foram buildados. */
const WEB_ROOT = resolve(process.cwd(), 'packages/web/dist');
const PANEL_ROOT = resolve(process.cwd(), 'packages/panel/dist');
const hasWeb = existsSync(WEB_ROOT);
const hasPanel = existsSync(PANEL_ROOT);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Serve um arquivo do diretorio, caindo no index.html quando nao existe. */
function serveStatic(root: string, relative: string, res: ServerResponse): void {
  // normalize + prefixo obrigatorio bloqueia path traversal com ../
  const safe = normalize(decodeURIComponent(relative)).replace(/^([/\\])+/, '');
  let file = join(root, safe);
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

function clientIp(req: IncomingMessage): string {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const ip = first?.split(',')[0]?.trim();
    if (ip) return ip;
  }
  return req.socket.remoteAddress ?? '?';
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;

  // A raiz do dominio principal e a vitrine publica. Subdominios de servidores
  // continuam abrindo o cliente Vox normalmente.
  if ((path === '/' || path === '/index.html') && isLandingHost(req.headers.host)) {
    return serveStatic(WEB_ROOT, 'landing.html', res);
  }

  if (path === '/health') {
    const hostHub = registry.getByHost(String(req.headers.host ?? ''));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        servers: hostHub ? registry.snapshot().filter((server) => server.id === hostHub.id) : registry.snapshot(),
        clients: hostHub ? hostHub.clientCount : registry.totalClients,
        panel: adminEnabled,
      }),
    );
    return;
  }

  // O Caddy consulta isto antes de emitir TLS sob demanda para um subdominio.
  // So slugs existentes podem gerar certificados, evitando abuso do dominio.
  if (path === '/internal/caddy-ask') {
    const domain = new URL(req.url ?? '/', 'http://localhost').searchParams.get('domain') ?? '';
    res.writeHead(registry.getByHost(domain) ? 200 : 403);
    res.end();
    return;
  }

  if (admin.handle(req, res, path, clientIp(req))) return;

  // Icones customizaveis servidos de VOX_ICONS_DIR (default /root/icons).
  // Use nas URLs de icones de grupo/canal: /icons/leader.png
  if (path.startsWith('/icons/')) {
    return serveStatic(config.iconsDir, path.slice('/icons'.length), res);
  }

  if (path === '/admin' || path.startsWith('/admin/')) {
    if (!hasPanel) {
      res.writeHead(404).end('painel nao buildado (npm run build:panel)');
      return;
    }
    return serveStatic(PANEL_ROOT, path.slice('/admin'.length) || '/', res);
  }

  if (!hasWeb) {
    res.writeHead(404).end('vox server');
    return;
  }
  serveStatic(WEB_ROOT, path, res);
}

function isLandingHost(rawHost: string | undefined): boolean {
  const host = String(rawHost ?? '').split(':')[0]?.toLowerCase() ?? '';
  const base = config.baseDomain.toLowerCase();
  return host === base || host === `www.${base}`;
}

const server = tlsEnabled
  ? createHttpsServer(
      { cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey) },
      handle,
    )
  : createHttpServer(handle);

attachWebSocket(server, registry);
attachEdgeWebSocket(server, registry);

// ----------------------------------------------------------- manutencao --

const sweeper = setInterval(() => registry.sweep(Date.now()), 5_000);
/** Presenca no painel: reenvia o estado mesmo sem ninguem clicar em nada. */
const pulse = setInterval(() => admin.broadcastState(), 3_000);
pulse.unref();

/**
 * WebTransport e melhoria, nao requisito: se faltar certificado ou modulo
 * nativo, o servidor sobe do mesmo jeito e a voz continua no WebSocket.
 */
let voice: VoiceEndpoint | null = null;

/**
 * Mantem os edges regionais e acrescenta a propria origem como uma segunda
 * rota. Assim, um usuario em outra regiao tambem consegue testar o caminho
 * direto ate a VPS principal sem precisar de uma terceira maquina.
 */
function voiceEndpointWithOrigin(hostname: string): {
  host: string;
  port: number;
  certHash: Uint8Array;
  edges: VoiceEdge[];
} {
  const local = voice?.endpointFor(hostname);
  const originEdge: VoiceEdge | null = local && local.host && local.port > 0
    ? {
        host: local.host,
        port: local.port,
        region: config.voiceOriginRegion,
        certHash: local.certHash,
      }
    : null;
  const edges = [...config.voiceEdges];
  if (originEdge && !edges.some((edge) => edge.host === originEdge.host && edge.port === originEdge.port)) {
    edges.push(originEdge);
  }
  const primary = edges[0] ?? originEdge;
  return {
    host: primary?.host ?? '',
    port: primary?.port ?? 0,
    certHash: primary?.certHash ?? new Uint8Array(0),
    edges,
  };
}

if (config.voiceEdges.length > 0) {
  // Disponibiliza o edge regional desde o primeiro instante, enquanto o
  // listener QUIC da origem termina de carregar o certificado.
  registry.setVoiceEndpointProvider((hostname) => voiceEndpointWithOrigin(hostname));
}

// O WebTransport local continua ativo mesmo quando existem edges regionais.
// Ele vira automaticamente mais um candidato no Welcome.
startVoiceTransport(registry)
  .then((endpoint) => {
    voice = endpoint;
    if (!endpoint) {
      if (config.voiceEdges.length === 0) {
        console.log('[vox] voz no WebSocket (sem WebTransport: falta certificado UDP)');
      } else {
        console.log('[vox] edge(s) regionais ativos; QUIC local da origem indisponível');
      }
      return;
    }

    registry.setVoiceEndpointProvider((hostname) => {
      if (config.voiceEdges.length > 0) return voiceEndpointWithOrigin(hostname);
      const local = endpoint.endpointFor(hostname);
      const edges: VoiceEdge[] = local.host && local.port > 0
        ? [{ host: local.host, port: local.port, region: config.voiceOriginRegion, certHash: local.certHash }]
        : [];
      return { ...local, edges };
    });

    if (config.voiceEdges.length > 0) {
      console.log(`[vox] ${config.voiceEdges.length + 1} edge(s) de voz anunciados; origem direta em ${config.voiceOriginRegion}`);
    } else {
      console.log(`[vox] voz por WebTransport em udp/${endpoint.port} (${config.wtHost})`);
    }
    if (endpoint.certHash.length > 0) {
      console.log('[vox] publicando o hash do certificado (modo desenvolvimento)');
    }
  })
  .catch((err) => console.error('[vox] WebTransport falhou ao iniciar:', err));

server.listen(config.port, config.host, () => {
  const scheme = tlsEnabled ? 'wss' : 'ws';
  console.log(`[vox] ouvindo em ${scheme}://${config.host}:${config.port}/vox`);
  for (const s of registry.snapshot()) {
    const lock = s.protected ? ' (com senha)' : '';
    console.log(`[vox]   servidor ${s.id}: "${s.name}" - ${s.channels} canais${lock}`);
  }
  if (hasWeb) console.log(`[vox] cliente web em ${WEB_ROOT}`);
  if (hasPanel && adminEnabled) console.log('[vox] painel em /admin');
  if (!adminEnabled) console.log('[vox] painel desligado (defina VOX_ADMIN_PASSWORD)');
  if (config.trustProxy) console.log('[vox] confiando no X-Forwarded-For');
  if (!tlsEnabled) {
    console.log(
      '[vox] sem TLS: navegadores so liberam o microfone em contexto seguro.\n' +
        '      Use um proxy reverso com HTTPS, ou defina VOX_TLS_CERT e VOX_TLS_KEY.\n' +
        '      (http://localhost e a unica excecao, para desenvolvimento.)',
    );
  }

  for (const hub of registry.list()) {
    const envCfg = botConfigFromEnv();
    const stored = hub.botConfig;
    const cfg = stored.enabled && stored.world
      ? stored
      : envCfg && !stored.world
        ? envCfg
        : null;
    if (cfg && cfg.enabled && cfg.world) {
      const bot = new RubinotBot(hub, cfg);
      hub.rubinot = bot;
      bot.start().catch((err) => console.error(`[bot] servidor ${hub.id}: falha ao iniciar:`, err));
    }
  }
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log('\n[vox] encerrando...');
    for (const hub of registry.list()) hub.rubinot?.stop();
    void shutdownRubinotClient();
    clearInterval(sweeper);
    clearInterval(pulse);
    void voice?.stop();
    registry.saveNow();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
