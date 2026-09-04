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
  VOICE_PROBE_BYTES,
  VOICE_PROBE_MAGIC,
  decodeServerMessage,
  decodeVoice,
  encodeClientMessage,
} from '@vox/protocol';
import type { ClientMessage, ServerMessage, VoiceEdge, VoicePacket } from '@vox/protocol';
import type { Identity } from '../identity.js';

export type LinkState = 'offline' | 'connecting' | 'online';

/** Por onde a voz esta andando neste momento. */
export type VoiceTransport = 'ws' | 'quic';
export type VoiceQuality = 'unknown' | 'measuring' | 'excellent' | 'good' | 'unstable';

export interface ConnectionHandlers {
  onState(state: LinkState, detail: string): void;
  onMessage(m: ServerMessage): void;
  onVoice(p: VoicePacket): void;
  onVoiceTransport?(transport: VoiceTransport): void;
  onVoiceStats?(): void;
}

/**
 * Acima disso o socket ja esta represando: descartar voz nova e melhor do que
 * entregar audio de tres segundos atras.
 */
const BACKPRESSURE_BYTES = 64 * 1024;

const PING_INTERVAL_MS = 4000;

/**
 * Datagramas em voo antes de comecar a descartar. Diferente do WebSocket, aqui
 * nao ha fila que cresce sozinha - mas a promessa de write ainda pode demorar
 * se a placa de rede engasgar, e voz velha nao vale a pena.
 */
const MAX_INFLIGHT_DATAGRAMS = 8;

/** Espera entre tentativas: 1s, 2s, 4s... ate o teto. */
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 15_000;
const OPEN_TIMEOUT_MS = 8000;
/**
 * Se nunca chegamos a entrar, o endereco provavelmente esta errado - insistir
 * so prende o usuario numa tela que nao vai a lugar nenhum. Depois de ja ter
 * entrado uma vez, o servidor caiu e vale esperar ele voltar para sempre.
 */
const COLD_ATTEMPTS = 3;

export interface Target {
  address: string;
  nickname: string;
  password: string;
  identity: Identity;
  /** Servidor virtual; 0 = o primeiro do processo. */
  serverId: number;
}

export class Connection {
  private ws: WebSocket | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  private target: Target | null = null;
  private attempt = 0;
  private everOnline = false;
  private closedByUser = false;
  private retryAllowed = true;
  private terminalReason = '';

  /** Host do socket de controle, base para achar o canal de voz. */
  private host = '';
  /**
   * Sobe a cada (re)conexao. Um upgrade de voz que estava a meio caminho
   * quando a conexao caiu descobre por aqui que ja nao interessa a ninguem.
   */
  private generation = 0;

  private wt: WebTransport | null = null;
  private wtWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private wtProbeWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private wtProbeTimer: ReturnType<typeof setInterval> | null = null;
  private wtProbeSequence = 0;
  private wtInflight = 0;

  /** WebSocket ate o WebTransport subir; 'quic' quando a voz migrou. */
  voiceTransport: VoiceTransport = 'ws';

  /** Ida e volta ate o servidor, em ms. */
  rtt = 0;
  /** Ida e volta do link de voz QUIC ate o edge escolhido, em ms. */
  voiceRtt = 0;
  /** Qualidade estimada do link de voz a partir do RTT e descartes locais. */
  voiceQuality: VoiceQuality = 'unknown';
  /** Host/regiao do edge que respondeu para esta sessao. */
  voiceHost = '';
  voiceRegion = '';
  /** Datagramas de voz aceitos nos sentidos de envio e recebimento. */
  voicePacketsSent = 0;
  voicePacketsReceived = 0;
  /** Pacotes de voz descartados por congestionamento. */
  droppedVoice = 0;

  constructor(private readonly handlers: ConnectionHandlers) {}

  get online(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(target: Target): void {
    this.close();
    this.target = target;
    this.attempt = 0;
    this.everOnline = false;
    this.closedByUser = false;
    this.retryAllowed = true;
    this.terminalReason = '';
    this.resetVoiceMetrics();
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

    const url = resolveUrl(target.address, target.serverId);
    this.host = hostOf(url);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.giveUp(`endereco invalido: ${String(err)}`);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    this.openTimer = setTimeout(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.CONNECTING) return;
      ws.close();
      this.teardown();
      this.scheduleRetry('tempo esgotado ao conectar');
    }, OPEN_TIMEOUT_MS);

    ws.onopen = () => {
      if (this.openTimer !== null) {
        clearTimeout(this.openTimer);
        this.openTimer = null;
      }
      this.send({
        t: Op.Hello,
        version: PROTOCOL_VERSION,
        nickname: target.nickname,
        password: target.password,
        publicKey: target.identity.publicKey,
        platform: '__TAURI_INTERNALS__' in window ? 'Desktop' : 'Web',
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
      if (!this.retryAllowed) {
        this.giveUp(this.terminalReason || ev.reason || 'servidor recusou a conexão');
      } else {
        this.scheduleRetry(ev.reason);
      }
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
      this.handlers.onVoiceStats?.();
      return;
    }
    if (msg.t === Op.Failure) {
      // Recusas do servidor (senha, versão, banimento, lotação) não devem
      // entrar no ciclo de reconexão automática: são falhas definitivas até
      // o usuário corrigir a configuração.
      this.retryAllowed = false;
      this.terminalReason = msg.message;
    }
    // O desafio se resolve aqui dentro: quem chamou connect nao precisa saber
    // que existe um handshake de tres etapas.
    if (msg.t === Op.Challenge) {
      void this.answerChallenge(msg.nonce);
      return;
    }
    if (msg.t === Op.Welcome) {
      this.attempt = 0;
      this.everOnline = true;
      this.handlers.onState('online', msg.serverName);
      const fallback: VoiceEdge = {
        host: msg.voiceHost || this.host,
        port: msg.wtPort,
        region: regionFromHost(msg.voiceHost || this.host),
        certHash: msg.wtCertHash,
      };
      const edges = msg.voiceEdges?.length > 0 ? msg.voiceEdges : [fallback];
      this.voiceHost = edges[0]?.host ?? fallback.host;
      this.voiceRegion = edges[0]?.region || regionFromHost(this.voiceHost);
      void this.upgradeVoice(msg.voiceToken, edges);
    }
    this.handlers.onMessage(msg);
  }

  private async answerChallenge(nonce: Uint8Array): Promise<void> {
    const target = this.target;
    if (!target) return;
    const generation = this.generation;
    try {
      const signature = await target.identity.sign(nonce);
      if (generation !== this.generation) return; // caiu enquanto assinava
      this.send({ t: Op.Auth, signature });
    } catch {
      this.giveUp('falha ao assinar o desafio');
    }
  }

  send(m: ClientMessage): void {
    if (!this.online) return;
    this.ws!.send(encodeClientMessage(m));
  }

  /** Caminho quente: sem alocacao alem do proprio frame. */
  sendVoice(frame: Uint8Array): void {
    const writer = this.wtWriter;
    if (writer) {
      if (this.wtInflight >= MAX_INFLIGHT_DATAGRAMS) {
        this.droppedVoice++;
        this.voiceQuality = this.qualityFromMetrics();
        this.handlers.onVoiceStats?.();
        return;
      }
      this.wtInflight++;
      const generation = this.generation;
      writer.write(frame).then(
        () => {
          this.wtInflight--;
        },
        () => {
          this.wtInflight--;
          this.dropVoiceChannel(generation);
        },
      );
      this.voicePacketsSent++;
      return;
    }

    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > BACKPRESSURE_BYTES) {
      this.droppedVoice++;
      this.handlers.onVoiceStats?.();
      return;
    }
    ws.send(frame);
  }

  // ------------------------------------------------------ canal de voz --

  /**
   * Tenta migrar a voz para datagramas QUIC. E oportunista de proposito:
   * qualquer tropeco aqui deixa a voz no WebSocket, que ja funciona. O usuario
   * nunca fica sem audio por causa de uma otimizacao.
   */
  private async upgradeVoice(token: Uint8Array, edges: VoiceEdge[]): Promise<void> {
    const candidates = edges.filter((edge) => edge.host && edge.port > 0);
    if (candidates.length === 0 || typeof WebTransport === 'undefined') return;
    const generation = this.generation;

    try {
      // O edge só é considerado vencedor depois do handshake completo. Assim,
      // um QUIC que abriu mas não consegue falar com a origem não bloqueia os
      // demais candidatos.
      const { wt, edge } = await this.openFastestEdge(candidates, token, generation);
      if (generation !== this.generation) return wt.close();

      // A especificacao trocou `writable` por `createWritable()`; navegadores
      // estao em pontos diferentes dessa transicao.
      const duplex = wt.datagrams as WebTransportDatagramDuplexStream & {
        createWritable?: () => WritableStream<Uint8Array>;
      };
      const datagrams = duplex.createWritable ? duplex.createWritable() : duplex.writable;
      this.wt = wt;
      this.wtWriter = datagrams.getWriter();
      this.wtInflight = 0;
      this.voiceHost = edge.host;
      this.voiceRegion = edge.region || regionFromHost(edge.host);
      this.voiceTransport = 'quic';
      this.voiceQuality = 'measuring';
      this.startVoiceProbe(wt, generation);
      this.handlers.onVoiceTransport?.('quic');
      void wt.closed.catch(() => {}).then(() => this.dropVoiceChannel(generation));
      void this.readDatagrams(wt, generation);
    } catch {
      this.dropVoiceChannel(generation);
    }
  }

  /**
   * Abre os candidatos em paralelo e conserva o primeiro que completa o
   * handshake de voz. O WebTransport `ready` sozinho não basta: o edge pode
   * estar acessível, mas sem o link privado até a origem.
   */
  private async openFastestEdge(
    edges: VoiceEdge[],
    token: Uint8Array,
    generation: number,
  ): Promise<{ wt: WebTransport; edge: VoiceEdge }> {
    const transports: { wt: WebTransport; edge: VoiceEdge }[] = [];
    for (const edge of edges) {
      const init: WebTransportOptions = {};
      if (edge.certHash.length > 0) {
        init.serverCertificateHashes = [
          { algorithm: 'sha-256', value: Uint8Array.from(edge.certHash) },
        ];
      }
      try {
        transports.push({ wt: new WebTransport(`https://${edge.host}:${edge.port}/vox`, init), edge });
      } catch {
        // Um candidato malformado nao impede os outros de serem testados.
      }
    }
    if (transports.length === 0) throw new Error('nenhum edge de voz valido');

    const pending = new Set(transports.map((candidate) => ({
      candidate,
      ready: candidate.wt.ready.then(
        () => ({ ok: true as const }),
        (error) => ({ ok: false as const, error }),
      ),
    })));
    let lastError: unknown = new Error('nenhum edge de voz respondeu');

    try {
      while (pending.size > 0) {
        const settled = await Promise.race(
          [...pending].map((attempt) => attempt.ready.then((result) => ({ attempt, result }))),
        );
        pending.delete(settled.attempt);
        const candidate = settled.attempt.candidate;
        if (!settled.result.ok) {
          lastError = settled.result.error;
          candidate.wt.close();
          continue;
        }

        try {
          await this.authenticateVoice(candidate.wt, token, generation);
          for (const attempt of pending) attempt.candidate.wt.close();
          return candidate;
        } catch (error) {
          lastError = error;
          candidate.wt.close();
        }
      }
    } finally {
      for (const attempt of pending) attempt.candidate.wt.close();
    }

    throw lastError;
  }

  private async authenticateVoice(wt: WebTransport, token: Uint8Array, generation: number): Promise<void> {
    if (generation !== this.generation) throw new Error('conexão de voz substituída');
    // O segredo vai por stream: handshake perdido deixaria o canal pendurado.
    const stream = await wt.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    await writer.write(token);
    const reply = await stream.readable.getReader().read();
    if (reply.value?.[0] !== 1) throw new Error('edge recusou a sessão de voz');
    if (generation !== this.generation) throw new Error('conexão de voz substituída');
  }

  private startVoiceProbe(wt: WebTransport, generation: number): void {
    void wt.createBidirectionalStream().then((stream) => {
      if (generation !== this.generation) return;
      this.wtProbeWriter = stream.writable.getWriter();
      void this.readVoiceProbes(stream.readable.getReader(), generation);
      this.sendVoiceProbe(generation);
      this.wtProbeTimer = setInterval(() => this.sendVoiceProbe(generation), 2000);
    }).catch(() => {
      // A falha no medidor nao derruba a voz QUIC.
    });
  }

  private sendVoiceProbe(generation: number): void {
    const writer = this.wtProbeWriter;
    if (generation !== this.generation || !writer) return;
    const payload = new Uint8Array(VOICE_PROBE_BYTES);
    const view = new DataView(payload.buffer);
    payload[0] = VOICE_PROBE_MAGIC;
    view.setUint32(1, ++this.wtProbeSequence, true);
    view.setFloat64(5, performance.now(), true);
    void writer.write(payload).catch(() => {});
  }

  private async readVoiceProbes(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    generation: number,
  ): Promise<void> {
    for (;;) {
      try {
        const chunk = await reader.read();
        if (chunk.done) return;
        const value = chunk.value;
        if (generation !== this.generation || value.length < VOICE_PROBE_BYTES || value[0] !== VOICE_PROBE_MAGIC) continue;
        const sentAt = new DataView(value.buffer, value.byteOffset, value.byteLength).getFloat64(5, true);
        const sample = performance.now() - sentAt;
        if (!Number.isFinite(sample) || sample < 0 || sample > 60_000) continue;
        this.voiceRtt = Math.max(1, Math.round(sample));
        this.voiceQuality = this.qualityFromMetrics();
        this.handlers.onVoiceStats?.();
      } catch {
        return;
      }
    }
  }

  private qualityFromMetrics(): VoiceQuality {
    if (this.voiceTransport !== 'quic') return 'unknown';
    if (this.voiceRtt === 0) return 'measuring';
    if (this.droppedVoice > 0 || this.voiceRtt > 120) return 'unstable';
    if (this.voiceRtt > 60) return 'good';
    return 'excellent';
  }

  private resetVoiceMetrics(): void {
    this.voiceRtt = 0;
    this.voiceQuality = 'unknown';
    this.voiceHost = '';
    this.voiceRegion = '';
    this.voicePacketsSent = 0;
    this.voicePacketsReceived = 0;
  }

  private async readDatagrams(wt: WebTransport, generation: number): Promise<void> {
    const reader = wt.datagrams.readable.getReader();
    for (;;) {
      let frame: Uint8Array | undefined;
      try {
        const chunk = await reader.read();
        if (chunk.done) break;
        frame = chunk.value;
      } catch {
        break;
      }
      if (generation !== this.generation) return;
      if (!frame || frame[0] !== FrameKind.Voice) continue;
      const packet = decodeVoice(frame);
      if (packet) {
        this.voicePacketsReceived++;
        this.handlers.onVoice(packet);
      }
    }
    this.dropVoiceChannel(generation);
  }

  /** Volta a voz para o WebSocket. Ignora avisos de uma conexao ja substituida. */
  private dropVoiceChannel(generation: number): void {
    if (generation !== this.generation) return;
    const changed = this.voiceTransport !== 'ws';
    this.voiceTransport = 'ws';
    this.voiceRtt = 0;
    this.voiceQuality = 'unknown';
    this.voiceHost = '';
    this.voiceRegion = '';
    if (this.wtProbeTimer !== null) {
      clearInterval(this.wtProbeTimer);
      this.wtProbeTimer = null;
    }
    const probeWriter = this.wtProbeWriter;
    this.wtProbeWriter = null;
    void probeWriter?.close().catch(() => {});
    this.wtWriter = null;
    this.wtInflight = 0;
    const wt = this.wt;
    this.wt = null;
    try {
      wt?.close();
    } catch {
      // ja fechada
    }
    if (changed) this.handlers.onVoiceTransport?.('ws');
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
    // Invalida qualquer upgrade de voz em andamento antes de soltar o socket.
    this.generation++;
    this.voiceTransport = 'ws';
    this.resetVoiceMetrics();
    if (this.wtProbeTimer !== null) {
      clearInterval(this.wtProbeTimer);
      this.wtProbeTimer = null;
    }
    const probeWriter = this.wtProbeWriter;
    this.wtProbeWriter = null;
    void probeWriter?.close().catch(() => {});
    this.wtWriter = null;
    this.wtInflight = 0;
    try {
      this.wt?.close();
    } catch {
      // ja fechada
    }
    this.wt = null;

    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.openTimer !== null) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
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
/** Hostname do socket de controle: o canal de voz mora no mesmo host. */
function hostOf(wsUrl: string): string {
  try {
    return new URL(wsUrl).hostname;
  } catch {
    return location.hostname;
  }
}

function regionFromHost(host: string): string {
  const value = host.toLowerCase();
  if (value.includes('sp') || value.includes('sao-paulo') || value.includes('sao_paulo')) return 'São Paulo';
  if (value.includes('dallas') || value.includes('dal')) return 'Dallas';
  return host;
}

function resolveUrl(address: string, serverId = 0): string {
  // `/vox/3` entra no servidor virtual 3; `/vox` cai no primeiro do processo.
  const path = serverId > 0 ? `/vox/${serverId}` : '/vox';
  const raw = address.trim();
  if (/^wss?:\/\//i.test(raw)) return raw;

  if (!raw) {
    if (isDesktopShell) return `ws://127.0.0.1:${DEFAULT_PORT}${path}`;
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
  }

  const host = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const hasPort = host.endsWith(']') ? false : /:\d+$/.test(host);
  // Endereco escrito a mao herda o esquema da pagina: em https, ws:// seria
  // bloqueado como conteudo misto antes mesmo de sair do navegador.
  const scheme = !isDesktopShell && location.protocol === 'https:' ? 'wss' : 'ws';
  const port = hasPort ? '' : (!isDesktopShell && location.protocol === 'https:' ? '' : `:${DEFAULT_PORT}`);
  return `${scheme}://${host}${port}${path}`;
}
