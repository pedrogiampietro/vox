/**
 * Transporte WebSocket.
 *
 * E o transporte universal: funciona em qualquer navegador, atravessa proxy e
 * so precisa da porta HTTPS. O custo e o TCP - uma perda de pacote trava a fila
 * inteira e a voz engasga. Por isso a interface abaixo e estreita de proposito:
 * quando o WebTransport (datagramas sobre QUIC) entrar, ele implementa o mesmo
 * PeerSocket e o Hub nao muda uma linha.
 */

import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_CONTROL_FRAME } from '@vox/protocol';
import { config } from './config.js';
import type { Hub } from './hub.js';
import type { PeerSocket } from './session.js';

export function attachWebSocket(server: HttpServer | HttpsServer, hub: Hub): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    path: '/vox',
    // Comprimir voz Opus e desperdicio puro: ja esta comprimida e o deflate
    // adiciona latencia e CPU em cada um dos 50 pacotes por segundo.
    perMessageDeflate: false,
    maxPayload: MAX_CONTROL_FRAME,
    skipUTF8Validation: true,
  });

  /** Conexoes abertas por IP, para o teto de VOX_MAX_PER_IP. */
  const openPerIp = new Map<string, number>();

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const ip = clientIp(req);
    const open = openPerIp.get(ip) ?? 0;
    if (config.maxPerIp > 0 && open >= config.maxPerIp) {
      ws.close(4001, 'limite de conexoes por IP');
      return;
    }
    openPerIp.set(ip, open + 1);

    ws.binaryType = 'nodebuffer';

    const peer: PeerSocket = {
      remote: ip,
      send(data) {
        if (ws.readyState === ws.OPEN) ws.send(data);
      },
      close(reason) {
        try {
          ws.close(4000, reason.slice(0, 120));
        } catch {
          ws.terminate();
        }
      },
    };

    const session = hub.accept(peer);

    ws.on('message', (data, isBinary) => {
      // O protocolo e inteiramente binario; texto so pode ser cliente errado.
      if (!isBinary) return peer.close('esperado binario');
      hub.handleFrame(session, toBytes(data));
    });

    const release = (): void => {
      const left = (openPerIp.get(ip) ?? 1) - 1;
      if (left <= 0) openPerIp.delete(ip);
      else openPerIp.set(ip, left);
      hub.drop(session);
    };

    ws.once('close', release);
    ws.once('error', release);
  });

  return wss;
}

/**
 * Atras de um proxy reverso o socket sempre vem do proxy, entao o IP real esta
 * no X-Forwarded-For. Sem VOX_TRUST_PROXY ligado o cabecalho e ignorado - ele e
 * trivial de forjar quando o cliente fala direto com o servidor.
 */
function clientIp(req: IncomingMessage): string {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const ip = first?.split(',')[0]?.trim();
    if (ip) return ip;
  }
  return req.socket.remoteAddress ?? '?';
}

/** ws entrega Buffer ou fragmentos; normaliza sem copiar quando possivel. */
function toBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}
