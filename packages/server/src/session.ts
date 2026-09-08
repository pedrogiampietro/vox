import { Group, NO_CHANNEL } from '@vox/protocol';
import { serverMetrics } from './metrics.js';

/**
 * Saida de voz alternativa (hoje, WebTransport). Quando existe, a voz sai por
 * ela; quando nao, cai no mesmo socket do controle.
 */
export interface VoiceSink {
  send(frame: Uint8Array): void;
  close(): void;
  /** Identifica clientes atendidos pelo mesmo edge regional. */
  readonly edgeId?: string;
  /** Grupo físico de fan-out; um edge multiplexado compartilha este sink. */
  readonly voiceGroupId?: string;
  /** Entrega um frame uma vez ao edge, que distribui no canal localmente. */
  sendChannel?(channelId: number, frame: Uint8Array): void;
  /** Atualiza o estado necessario para o edge fazer o encaminhamento local. */
  updateState?(state: VoiceState): void;
}

export interface VoiceState {
  channelId: number;
  channelFlags: number;
  clientFlags: number;
  group: number;
}

/** O que o Hub precisa de um transporte, seja WebSocket, WebTransport ou UDP. */
export interface PeerSocket {
  send(data: Uint8Array): void;
  /** Caminho de voz, separado para aplicar backpressure sem afetar controle. */
  sendVoice?(data: Uint8Array): void;
  close(reason: string): void;
  readonly remote: string;
  /** Hostname usado no WebSocket; determina o certificado/porta do QUIC. */
  readonly hostname?: string;
}

/** Balde de tokens com janela de 1s - barato e suficiente contra flood. */
export class RateLimiter {
  private tokens: number;
  private windowStart = 0;

  constructor(private readonly perSecond: number) {
    this.tokens = perSecond;
  }

  take(now: number): boolean {
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.tokens = this.perSecond;
    }
    if (this.tokens <= 0) return false;
    this.tokens--;
    return true;
  }
}

/**
 * Etapas do handshake.
 *
 * `challenged` existe porque a identidade so vale se for provada: entre o
 * Hello e o Welcome o cliente precisa assinar um desafio aleatorio. Sem esse
 * estado intermediario, bastaria alegar a chave publica de outra pessoa para
 * herdar o grupo dela.
 */
export type Stage = 'new' | 'challenged' | 'live';

export class Session {
  /** 0 ate o handshake terminar. */
  id = 0;
  stage: Stage = 'new';
  nickname = '';
  flags = 0;
  channelId: number = NO_CHANNEL;
  /** Canal para onde o cliente volta depois do AFK automático por mute. */
  afkReturnChannelId: number = NO_CHANNEL;
  lastSeen = Date.now();
  connectedAt = Date.now();
  platform = 'Web';

  /** Servidor virtual desta sessao. */
  serverId = 0;

  // --- identidade -----------------------------------------------------------
  publicKey: Uint8Array = new Uint8Array(0);
  fingerprint = '';
  group: Group = Group.Guest;
  /** Desafio pendente de assinatura; vazio fora do estado `challenged`. */
  nonce: Uint8Array = new Uint8Array(0);
  /** Apelido pedido no Hello, aplicado so quando a assinatura confere. */
  wantedNickname = '';
  /** Se o login foi feito com a senha de admin. */
  adminLogin = false;

  /** Canal de voz dedicado, quando o cliente conseguiu abrir um. */
  voice: VoiceSink | null = null;
  /** Chave do segredo que autentica o canal de voz, em hex. */
  voiceKey = '';

  readonly voiceLimit: RateLimiter;
  readonly controlLimit: RateLimiter;

  constructor(
    readonly socket: PeerSocket,
    voiceRate: number,
    controlRate: number,
  ) {
    /** Hostname usado no controle, normalizado para procurar o certificado. */
    this.hostname = socket.hostname ?? '';
    this.voiceLimit = new RateLimiter(voiceRate);
    this.controlLimit = new RateLimiter(controlRate);
  }

  readonly hostname: string;

  get live(): boolean {
    return this.stage === 'live';
  }

  send(data: Uint8Array): void {
    serverMetrics.recordOutbound('control', data.byteLength);
    this.socket.send(data);
  }

  /**
   * Voz sai pelo canal dedicado quando existe. Um cliente em WebTransport e
   * outro em WebSocket convivem no mesmo canal sem o Hub saber a diferenca.
   */
  sendVoice(frame: Uint8Array, accountMetrics = true): void {
    if (accountMetrics) serverMetrics.recordOutbound('voice', frame.byteLength);
    if (this.voice) this.voice.send(frame);
    else if (this.socket.sendVoice) this.socket.sendVoice(frame);
    else this.socket.send(frame);
  }
}
