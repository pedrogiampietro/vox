/**
 * Superficie minima do @fails-components/webtransport que o Vox usa.
 *
 * Declarado aqui de proposito, e nao resolvido do pacote: a dependencia e
 * opcional (modulo nativo). Numa maquina onde o prebuild nao existe o pacote
 * simplesmente nao esta instalado, e mesmo assim o projeto tem que compilar -
 * o servidor so vai rodar sem WebTransport.
 */
declare module '@fails-components/webtransport' {
  export interface Http3ServerInit {
    port: string | number;
    host: string;
    secret: string;
    cert: string | string[];
    privKey: string | string[];
    defaultDatagramsReadableMode?: 'bytes';
    maxConnections?: number;
  }

  export class Http3Server {
    constructor(init: Http3ServerInit);
    readonly ready: Promise<unknown>;
    readonly closed: Promise<unknown>;
    startServer(): void;
    stopServer(): void;
    updateCert(cert: string, privKey: string, http2only: boolean): void;
    sessionStream(path: string): ReadableStream<unknown>;
  }

  /**
   * O addon nativo carrega de forma assincrona. Usar o cliente antes disso
   * resolver falha com "Lib quiche loading attempt did not end".
   */
  export const quicheLoaded: Promise<unknown>;

  export interface WebTransportInit {
    serverCertificateHashes?: { algorithm: string; value: BufferSource }[];
  }

  export class WebTransport {
    constructor(url: string, init?: WebTransportInit);
    readonly ready: Promise<unknown>;
    readonly closed: Promise<unknown>;
    close(info?: { closeCode?: number; reason?: string }): void;
    readonly datagrams: {
      readable: ReadableStream<Uint8Array>;
      createWritable?: () => WritableStream<Uint8Array>;
      writable?: WritableStream<Uint8Array>;
    };
    createBidirectionalStream(): Promise<{
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
    }>;
  }
}
