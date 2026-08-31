/**
 * Conexao com o servidor Vox.
 *
 * Hoje: um unico WebSocket binario multiplexando controle e voz pelo primeiro
 * byte do frame. O dia que o WebTransport entrar, so esta classe muda - o
 * resto do cliente conversa por callbacks.
 */

import {
  FrameKind,
  Op,
  PROTOCOL_VERSION,
  decodeServerMessage,
  decodeVoice,
  encodeClientMessage,
} from '@vox/protocol';
import type { ClientMessage, ServerMessage, VoicePacket } from '@vox/protocol';

export type LinkState = 'offline' | 'connecting' | 'online';

export interface ConnectionHandlers {
  onState(state: LinkState, detail: string): void;
  onMessage(m: ServerMessage): void;
  onVoice(p: VoicePacket): void;
}

/**
 * Acima disso o socket ja esta represando: descartar voz nova e melhor do que
 * entregar audio de tres segundos atras.
 */
const BACKPRESSURE_BYTES = 64 * 1024;

const PING_INTERVAL_MS = 4000;

/** Espera entre tentativas: 1s, 2s, 4s... ate o teto. */
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 15_000;
/**
 * Se nunca chegamos a entrar, o endereco provavelmente esta errado - insistir
 * so prende o usuario numa tela que nao vai a lugar nenhum. Depois de ja ter
 * entrado uma vez, o servidor caiu e vale esperar ele voltar para sempre.
 */
const COLD_ATTEMPTS = 3;

interface Target {
  address: string;
  nickname: string;
  password: string;
}

export class Connection {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  private target: Target | null = null;
  private attempt = 0;
  private everOnline = false;
  private closedByUser = false;

  /** Ida e volta ate o servidor, em ms. */
  rtt = 0;
  /** Pacotes de voz descartados por congestionamento. */
  droppedVoice = 0;

  constructor(private readonly handlers: ConnectionHandlers) {}

  get online(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(address: string, nickname: string, password: string): void {
    this.close();
    this.target = { address, nickname, password };
    this.attempt = 0;
    this.everOnline = false;
    this.closedByUser = false;
    this.open();
  }

  private open(): void {
    const target = this.target;
    if (!target) return;

    this.attempt++;
    this.handlers.onState(
      'connecting',
      this.attempt === 1 ? 'conectando...' : `reconectando (tentativa ${this.attempt})`,
    );

    const url = resolveUrl(target.address);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.giveUp(`endereco invalido: ${String(err)}`);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.send({
        t: Op.Hello,
        version: PROTOCOL_VERSION,
        nickname: target.nickname,
        password: target.password,
      });
      this.pingTimer = setInterval(() => {
        if (this.online) this.send({ t: Op.Ping, stamp: performance.now() });
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') return;
      this.receive(new Uint8Array(ev.data as ArrayBuffer));
    };

    // onerror sempre vem seguido de onclose; a decisao mora la, num lugar so.
    ws.onerror = () => {};

    ws.onclose = (ev) => {
      this.teardown();
      this.scheduleRetry(ev.reason);
    };
  }

  /**
   * O servidor recusou por regra (versao, senha, lotado): insistir seria spam.
   * Reconexao existe para queda de rede, nao para pedido negado.
   */
  private scheduleRetry(reason: string): void {
    if (this.closedByUser || !this.target) {
      this.handlers.onState('offline', reason || 'desconectado');
      return;
    }
    if (!this.everOnline && this.attempt >= COLD_ATTEMPTS) {
      this.giveUp(reason || 'nao foi possivel conectar');
      return;
    }

    const step = Math.min(RETRY_BASE_MS * 2 ** (this.attempt - 1), RETRY_MAX_MS);
    // Jitter evita que todo mundo volte no mesmo instante quando o servidor sobe.
    const delay = Math.round(step * (0.8 + Math.random() * 0.4));

    this.handlers.onState(
      'connecting',
      `${reason || 'conexao perdida'} - nova tentativa em ${Math.round(delay / 1000)}s`,
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  private giveUp(detail: string): void {
    this.target = null;
    this.handlers.onState('offline', detail);
  }

  private receive(frame: Uint8Array): void {
    if (frame.length === 0) return;

    if (frame[0] === FrameKind.Voice) {
      const packet = decodeVoice(frame);
      if (packet) this.handlers.onVoice(packet);
      return;
    }

    let msg: ServerMessage;
    try {
      msg = decodeServerMessage(frame);
    } catch {
      return; // frame corrompido: ignora, o controle e best effort na leitura
    }

    if (msg.t === Op.Pong) {
      this.rtt = Math.round(performance.now() - msg.stamp);
      return;
    }
    if (msg.t === Op.Welcome) {
      this.attempt = 0;
      this.everOnline = true;
      this.handlers.onState('online', msg.serverName);
    }
    this.handlers.onMessage(msg);
  }

  send(m: ClientMessage): void {
    if (!this.online) return;
    this.ws!.send(encodeClientMessage(m));
  }

  /** Caminho quente: sem alocacao alem do proprio frame. */
  sendVoice(frame: Uint8Array): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > BACKPRESSURE_BYTES) {
      this.droppedVoice++;
      return;
    }
    ws.send(frame);
  }

  /** Saida deliberada do usuario: cancela qualquer tentativa pendente. */
  close(): void {
    this.closedByUser = true;
    this.target = null;
    const ws = this.ws;
    this.teardown();
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000, 'saindo');
  }

  private teardown(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.ws = null;
  }
}

/**
 * Verdadeiro dentro da casca Tauri. Nao da para olhar o protocolo da pagina:
 * no Windows o WebView2 serve o app de http://tauri.localhost, que parece uma
 * origem HTTP normal mas nao tem servidor Vox nenhum atras.
 */
export const isDesktopShell =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Porta padrao do Vox, a mesma do TS3. */
const DEFAULT_PORT = 9987;

/**
 * Aceita "servidor.com", "servidor.com:9987", "ws://..." ou vazio.
 *
 * Vazio significa "a origem desta pagina", que e o certo na web (dev server e
 * build servido pelo proprio Vox). No desktop nao existe origem para herdar,
 * entao vazio cai na maquina local.
 */
function resolveUrl(address: string): string {
  const raw = address.trim();
  if (/^wss?:\/\//i.test(raw)) return raw;

  if (!raw) {
    if (isDesktopShell) return `ws://127.0.0.1:${DEFAULT_PORT}/vox`;
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/vox`;
  }

  const host = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const hasPort = host.endsWith(']') ? false : /:\d+$/.test(host);
  // Endereco escrito a mao herda o esquema da pagina: em https, ws:// seria
  // bloqueado como conteudo misto antes mesmo de sair do navegador.
  const scheme = !isDesktopShell && location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${hasPort ? host : `${host}:${DEFAULT_PORT}`}/vox`;
}
