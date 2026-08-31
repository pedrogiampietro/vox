import { NO_CHANNEL } from '@vox/protocol';

/** O que o Hub precisa de um transporte, seja WebSocket, WebTransport ou UDP. */
export interface PeerSocket {
  send(data: Uint8Array): void;
  close(reason: string): void;
  readonly remote: string;
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

export class Session {
  /** 0 ate o Hello ser aceito. */
  id = 0;
  nickname = '';
  flags = 0;
  channelId: number = NO_CHANNEL;
  authenticated = false;
  lastSeen = Date.now();

  readonly voiceLimit: RateLimiter;
  readonly controlLimit: RateLimiter;

  constructor(
    readonly socket: PeerSocket,
    voiceRate: number,
    controlRate: number,
  ) {
    this.voiceLimit = new RateLimiter(voiceRate);
    this.controlLimit = new RateLimiter(controlRate);
  }

  send(data: Uint8Array): void {
    this.socket.send(data);
  }
}
