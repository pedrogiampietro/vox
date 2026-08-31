/**
 * Cliente Vox: junta conexao, microfone e reproducao, e mantem uma copia do
 * estado do servidor. A interface le esse estado e chama os metodos daqui -
 * nao conhece protocolo nem Web Audio.
 */

import { ChatScope, ClientFlags, NO_CHANNEL, Op } from '@vox/protocol';
import type { ChannelInfo, ClientInfo, ServerMessage } from '@vox/protocol';
import { Connection, type LinkState } from './net/connection.js';
import { DEFAULT_MIC, Microphone, type MicSettings } from './audio/microphone.js';
import { VoiceMixer } from './audio/mixer.js';

export interface ChatLine {
  scope: ChatScope;
  senderId: number;
  senderName: string;
  text: string;
  stamp: number;
}

export interface Notice {
  kind: 'info' | 'error';
  text: string;
  stamp: number;
}

const MAX_CHAT_LINES = 300;

export class VoxClient {
  readonly channels = new Map<number, ChannelInfo>();
  readonly clients = new Map<number, ClientInfo>();
  readonly chat: ChatLine[] = [];
  notice: Notice | null = null;

  link: LinkState = 'offline';
  detail = '';
  serverName = '';
  motd = '';
  selfId = 0;

  mic: MicSettings = { ...DEFAULT_MIC };
  outputVolume = 1;

  private ctx: AudioContext | null = null;
  private workletsReady: Promise<void> | null = null;

  readonly connection: Connection;
  readonly microphone: Microphone;
  private mixer: VoiceMixer | null = null;

  constructor(private readonly onChange: () => void) {
    this.connection = new Connection({
      onState: (link, detail) => {
        this.link = link;
        this.detail = detail;
        if (link === 'offline') this.reset();
        // Reconectando: cala o audio mas deixa a arvore na tela, senao a
        // interface pisca vazia a cada oscilacao de rede.
        if (link === 'connecting') this.suspend();
        this.onChange();
      },
      onMessage: (m) => this.apply(m),
      onVoice: (p) => this.mixer?.push(p),
    });
    this.microphone = new Microphone((frame) => this.connection.sendVoice(frame));
  }

  get self(): ClientInfo | undefined {
    return this.clients.get(this.selfId);
  }

  get flags(): number {
    return this.self?.flags ?? 0;
  }

  isTalking(clientId: number): boolean {
    if (clientId === this.selfId) return this.microphone.transmitting;
    return this.mixer?.isTalking(clientId) ?? false;
  }

  /** Usuarios de um canal, em ordem alfabetica. */
  membersOf(channelId: number): ClientInfo[] {
    return [...this.clients.values()]
      .filter((c) => c.channelId === channelId)
      .sort((a, b) => a.nickname.localeCompare(b.nickname));
  }

  /** Canais filhos de um no, na ordem definida pelo servidor. */
  childrenOf(parentId: number): ChannelInfo[] {
    return [...this.channels.values()]
      .filter((c) => c.parentId === parentId)
      .sort((a, b) => a.order - b.order || a.id - b.id);
  }

  // ------------------------------------------------------------- sessao --

  async connect(address: string, nickname: string, password: string): Promise<void> {
    await this.ensureAudio();
    this.connection.connect(address, nickname, password);
  }

  disconnect(): void {
    this.connection.close();
  }

  private reset(): void {
    this.channels.clear();
    this.clients.clear();
    this.selfId = 0;
    this.suspend();
  }

  /** Solta os recursos de audio mantendo o estado visivel do servidor. */
  private suspend(): void {
    this.mixer?.clear();
    void this.microphone.stop();
  }

  // -------------------------------------------------------------- audio --

  /**
   * O AudioContext so pode nascer dentro de um gesto do usuario, por isso a
   * inicializacao mora no clique de conectar e nao no carregamento da pagina.
   */
  private async ensureAudio(): Promise<void> {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
      const base = import.meta.env.BASE_URL;
      this.workletsReady = Promise.all([
        this.ctx.audioWorklet.addModule(`${base}worklets/capture.js`),
        this.ctx.audioWorklet.addModule(`${base}worklets/playback.js`),
      ]).then(() => undefined);
    }
    await this.workletsReady;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (!this.mixer) {
      this.mixer = new VoiceMixer(this.ctx);
      this.mixer.volume = this.outputVolume;
    }
  }

  private async startMic(): Promise<void> {
    if (!this.ctx) return;
    try {
      await this.microphone.start(this.ctx, this.mic);
    } catch (err) {
      this.warn(`microfone indisponivel: ${describeError(err)}`);
      this.setFlags(this.flags | ClientFlags.NoInput | ClientFlags.MutedMic);
    }
  }

  async applyMicSettings(patch: Partial<MicSettings>): Promise<void> {
    const restart = patch.deviceId !== undefined && patch.deviceId !== this.mic.deviceId;
    this.mic = { ...this.mic, ...patch };
    this.microphone.reconfigure(patch);
    if (restart && this.link === 'online') await this.startMic();
    this.onChange();
  }

  setOutputVolume(v: number): void {
    this.outputVolume = v;
    if (this.mixer) this.mixer.volume = v;
    this.onChange();
  }

  // ------------------------------------------------------------ comandos --

  join(channelId: number, password = ''): void {
    this.connection.send({ t: Op.JoinChannel, channelId, password });
  }

  createChannel(name: string, password = '', parentId = NO_CHANNEL): void {
    this.connection.send({ t: Op.CreateChannel, name, parentId, maxClients: 0, password });
  }

  deleteChannel(channelId: number): void {
    this.connection.send({ t: Op.DeleteChannel, channelId });
  }

  say(text: string, scope: ChatScope = ChatScope.Channel, targetId = 0): void {
    const body = text.trim();
    if (body) this.connection.send({ t: Op.ChatSend, scope, targetId, text: body });
  }

  toggleMic(): void {
    this.setFlags(this.flags ^ ClientFlags.MutedMic);
  }

  toggleSpeakers(): void {
    const next = this.flags & ClientFlags.MutedSpeakers
      ? this.flags & ~(ClientFlags.MutedSpeakers | ClientFlags.MutedMic)
      : this.flags | ClientFlags.MutedSpeakers | ClientFlags.MutedMic;
    this.setFlags(next);
  }

  private setFlags(flags: number): void {
    this.connection.send({ t: Op.SetSelfState, flags });
    // Aplica localmente na hora: o servidor confirma no broadcast.
    this.microphone.muted = (flags & ClientFlags.MutedMic) !== 0;
    if (this.mixer) this.mixer.volume = flags & ClientFlags.MutedSpeakers ? 0 : this.outputVolume;
    const me = this.self;
    if (me) me.flags = flags;
    this.onChange();
  }

  setPtt(down: boolean): void {
    this.microphone.pttDown = down;
  }

  // ---------------------------------------------------------- recebidos --

  private apply(m: ServerMessage): void {
    switch (m.t) {
      case Op.Welcome:
        this.selfId = m.clientId;
        this.serverName = m.serverName;
        this.motd = m.motd;
        break;

      case Op.Snapshot:
        this.channels.clear();
        this.clients.clear();
        for (const c of m.channels) this.channels.set(c.id, c);
        for (const c of m.clients) this.clients.set(c.id, c);
        void this.startMic();
        break;

      case Op.ChannelAdd:
      case Op.ChannelUpdate:
        this.channels.set(m.channel.id, m.channel);
        break;

      case Op.ChannelRemove:
        this.channels.delete(m.channelId);
        break;

      case Op.ClientAdd:
        this.clients.set(m.client.id, m.client);
        break;

      case Op.ClientRemove:
        this.clients.delete(m.clientId);
        this.mixer?.remove(m.clientId);
        break;

      case Op.ClientMove: {
        const c = this.clients.get(m.clientId);
        if (c) c.channelId = m.channelId;
        break;
      }

      case Op.ClientState: {
        const c = this.clients.get(m.clientId);
        if (c) c.flags = m.flags;
        break;
      }

      case Op.ChatDeliver:
        this.chat.push(m);
        if (this.chat.length > MAX_CHAT_LINES) this.chat.shift();
        break;

      case Op.Failure:
        this.warn(m.message);
        break;
    }
    this.onChange();
  }

  private warn(text: string): void {
    this.notice = { kind: 'error', text, stamp: Date.now() };
    this.onChange();
  }
}

function describeError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') return 'permissao negada';
    if (err.name === 'NotFoundError') return 'nenhum dispositivo';
    return err.name;
  }
  return String(err);
}
