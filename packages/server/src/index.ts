/**
 * Entrada do servidor Vox.
 *
 * Um processo, uma porta: HTTP(S) para saude e para servir o cliente web
 * buildado, e o mesmo socket faz upgrade para WebSocket em /vox.
 */

import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { config, tlsEnabled } from './config.js';
import { Hub } from './hub.js';
import { attachWebSocket } from './transport-ws.js';
import { loadChannels, saveChannels } from './persistence.js';

// ---------------------------------------------------------------- estado --

const hub = new Hub(() => saveChannels(hub.exportPermanent()));

for (const c of loadChannels()) {
  const { password, ...info } = c;
  hub.seedChannel(info, password);
}

// ------------------------------------------------------------------ http --

/** Se o cliente web foi buildado, servimos dele mesmo - um processo so. */
const WEB_ROOT = resolve(process.cwd(), 'packages/web/dist');
const hasWeb = existsSync(WEB_ROOT);

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

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        name: config.serverName,
        clients: hub.clientCount,
        maxClients: config.maxClients,
        channels: hub.channelList.length,
        protected: config.password !== '',
      }),
    );
    return;
  }

  if (!hasWeb) {
    res.writeHead(404).end('vox server');
    return;
  }

  // normalize + prefixo obrigatorio bloqueia path traversal com ../
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  let file = join(WEB_ROOT, rel);
  if (!file.startsWith(WEB_ROOT)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(WEB_ROOT, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404).end();
    return;
  }

  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

const server = tlsEnabled
  ? createHttpsServer(
      { cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey) },
      handle,
    )
  : createHttpServer(handle);

attachWebSocket(server, hub);

// ------------------------------------------------------------ manutencao --

const sweeper = setInterval(() => hub.sweep(Date.now()), 5_000);

server.listen(config.port, config.host, () => {
  const scheme = tlsEnabled ? 'wss' : 'ws';
  console.log(`[vox] "${config.serverName}" em ${scheme}://${config.host}:${config.port}/vox`);
  console.log(`[vox] canais: ${hub.channelList.length} | limite: ${config.maxClients} clientes`);
  if (hasWeb) console.log(`[vox] servindo o cliente web de ${WEB_ROOT}`);
  if (config.password) console.log('[vox] servidor protegido por senha');
  if (config.trustProxy) console.log('[vox] confiando no X-Forwarded-For');
  if (!tlsEnabled) {
    console.log(
      '[vox] sem TLS: navegadores so liberam o microfone em contexto seguro.\n' +
        '      Use um proxy reverso com HTTPS, ou defina VOX_TLS_CERT e VOX_TLS_KEY.\n' +
        '      (http://localhost e a unica excecao, para desenvolvimento.)',
    );
  }
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log('\n[vox] encerrando...');
    clearInterval(sweeper);
    saveChannels(hub.exportPermanent());
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
