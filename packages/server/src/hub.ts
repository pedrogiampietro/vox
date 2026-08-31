/**
 * O Hub e todo o estado do servidor: canais, clientes e roteamento.
 *
 * Regra de ouro: o Hub nunca decodifica audio. Pacote de voz que chega e
 * carimbado com o id do remetente e reencaminhado como esta. Isso mantem o
 * custo por usuario em algumas centenas de bytes de estado e quase nenhum CPU.
 */

import {
  ChannelFlags,
  ChatScope,
  ClientFlags,
  FailureCode,
  FrameKind,
  NO_CHANNEL,
  Op,
  PROTOCOL_VERSION,
  RemoveReason,
  decodeClientMessage,
  encodeServerMessage,
  stampSender,
  MAX_CHAT_TEXT,
  MAX_NICKNAME,
  MAX_VOICE_PACKET,
  VOICE_HEADER_SIZE,
} from '@vox/protocol';
import type { ChannelInfo, ClientInfo, ClientMessage, ServerMessage } from '@vox/protocol';
import { config } from './config.js';
import { Session, type PeerSocket } from './session.js';
import { clean, clamp } from './util.js';

interface Channel {
  info: ChannelInfo;
  password: string;
  members: Set<Session>;
}

export class Hub {
  private readonly channels = new Map<number, Channel>();
  private readonly sessions = new Map<number, Session>();
  /** Conexoes abertas que ainda nao passaram pelo Hello. */
  private readonly pending = new Set<Session>();
  private readonly nicknames = new Set<string>();

  private nextClientId = 1;
  private nextChannelId = 1;

  constructor(private readonly onChannelsChanged: () => void = () => {}) {}

  // -------------------------------------------------------------- canais --

  get channelList(): ChannelInfo[] {
    return [...this.channels.values()].map((c) => c.info);
  }

  get clientCount(): number {
    return this.sessions.size;
  }

  /** Cria um canal sem passar pelas regras de permissao (boot / seed). */
  seedChannel(info: Omit<ChannelInfo, 'id'> & { id?: number }, password = ''): ChannelInfo {
    const id = info.id ?? this.allocChannelId();
    const full: ChannelInfo = { ...info, id };
    this.channels.set(id, { info: full, password, members: new Set() });
    if (id >= this.nextChannelId) this.nextChannelId = id + 1;
    return full;
  }

  /** Canais que devem sobreviver a um restart, com senha, para o disco. */
  exportPermanent(): (ChannelInfo & { password: string })[] {
    return [...this.channels.values()]
      .filter((c) => c.info.flags & ChannelFlags.Permanent)
      .map((c) => ({ ...c.info, password: c.password }));
  }

  private allocChannelId(): number {
    for (let i = 0; i < 0xffff; i++) {
      const id = this.nextChannelId;
      this.nextChannelId = this.nextChannelId >= 0xffff ? 1 : this.nextChannelId + 1;
      if (!this.channels.has(id)) return id;
    }
    throw new Error('sem ids de canal disponiveis');
  }

  private defaultChannel(): Channel | undefined {
    for (const c of this.channels.values()) {
      if (c.info.flags & ChannelFlags.Default) return c;
    }
    return this.channels.values().next().value;
  }

  // --------------------------------------------------------- ciclo de vida --

  accept(socket: PeerSocket): Session {
    const s = new Session(socket, config.voicePacketsPerSecond, config.controlMessagesPerSecond);
    this.pending.add(s);
    return s;
  }

  drop(s: Session, reason: RemoveReason = RemoveReason.Disconnected): void {
    this.pending.delete(s);
    if (!this.isLive(s)) return;

    this.leaveChannel(s);
    this.sessions.delete(s.id);
    this.nicknames.delete(s.nickname.toLowerCase());
    s.authenticated = false;
    this.broadcast({ t: Op.ClientRemove, clientId: s.id, reason });
  }

  private isLive(s: Session): boolean {
    return s.authenticated && this.sessions.get(s.id) === s;
  }

  /** Derruba quem parou de responder. Chamado por um timer no index. */
  sweep(now: number): void {
    for (const s of [...this.pending, ...this.sessions.values()]) {
      if (now - s.lastSeen > config.timeoutMs) {
        s.socket.close('timeout');
        this.drop(s, RemoveReason.Timeout);
      }
    }
  }

  // -------------------------------------------------------------- entrada --

  /** Ponto unico de entrada de dados. Nunca lanca; fecha a conexao no erro. */
  handleFrame(s: Session, frame: Uint8Array): void {
    const now = Date.now();
    s.lastSeen = now;
    if (frame.length === 0) return;

    if (frame[0] === FrameKind.Voice) {
      if (!s.voiceLimit.take(now)) return;
      this.routeVoice(s, frame);
      return;
    }
    if (frame[0] !== FrameKind.Control) {
      this.kick(s, FailureCode.Malformed, 'frame desconhecido');
      return;
    }
    if (!s.controlLimit.take(now)) {
      this.kick(s, FailureCode.RateLimited, 'muitas mensagens');
      return;
    }

    let msg: ClientMessage;
    try {
      msg = decodeClientMessage(frame);
    } catch {
      this.kick(s, FailureCode.Malformed, 'mensagem invalida');
      return;
    }
    this.handleControl(s, msg);
  }

  // ------------------------------------------------------------------ voz --

  private routeVoice(s: Session, frame: Uint8Array): void {
    if (!this.isLive(s)) return;
    if (frame.length <= VOICE_HEADER_SIZE || frame.length > MAX_VOICE_PACKET) return;
    if (s.flags & ClientFlags.MutedMic) return;

    const channel = this.channels.get(s.channelId);
    if (!channel) return;

    // Uma escrita de 2 bytes, e o mesmo buffer vai para todo mundo do canal.
    stampSender(frame, s.id);
    for (const peer of channel.members) {
      if (peer === s) continue;
      if (peer.flags & ClientFlags.MutedSpeakers) continue;
      peer.send(frame);
    }
  }

  // ------------------------------------------------------------- controle --

  private handleControl(s: Session, m: ClientMessage): void {
    if (m.t === Op.Hello) {
      this.handleHello(s, m.version, m.nickname, m.password);
      return;
    }
    if (!this.isLive(s)) {
      this.kick(s, FailureCode.NotPermitted, 'handshake ausente');
      return;
    }

    switch (m.t) {
      case Op.Ping:
        s.send(encodeServerMessage({ t: Op.Pong, stamp: m.stamp }));
        break;

      case Op.SetSelfState: {
        let flags = m.flags & 0xff;
        // Ouvido desligado implica microfone desligado, como no TS3.
        if (flags & ClientFlags.MutedSpeakers) flags |= ClientFlags.MutedMic;
        if (flags === s.flags) break;
        s.flags = flags;
        this.broadcast({ t: Op.ClientState, clientId: s.id, flags });
        break;
      }

      case Op.JoinChannel:
        this.joinChannel(s, m.channelId, m.password);
        break;

      case Op.CreateChannel:
        this.createChannel(s, m.name, m.parentId, m.maxClients, m.password);
        break;

      case Op.DeleteChannel:
        this.deleteChannel(s, m.channelId);
        break;

      case Op.EditChannel: {
        const ch = this.channels.get(m.channelId);
        if (!ch) return this.fail(s, FailureCode.ChannelNotFound, 'canal inexistente');
        ch.info.name = clean(m.name, 64) || ch.info.name;
        ch.info.topic = clean(m.topic, 128);
        ch.info.maxClients = clamp(m.maxClients, 0, 512);
        this.broadcast({ t: Op.ChannelUpdate, channel: ch.info });
        this.onChannelsChanged();
        break;
      }

      case Op.ChatSend:
        this.routeChat(s, m.scope, m.targetId, m.text);
        break;
    }
  }

  private handleHello(s: Session, version: number, nickname: string, password: string): void {
    if (s.authenticated) return this.kick(s, FailureCode.NotPermitted, 'handshake repetido');
    if (version !== PROTOCOL_VERSION) {
      return this.kick(s, FailureCode.VersionMismatch, `servidor fala a versao ${PROTOCOL_VERSION}`);
    }
    if (config.password && password !== config.password) {
      return this.kick(s, FailureCode.BadPassword, 'senha incorreta');
    }
    if (this.sessions.size >= config.maxClients) {
      return this.kick(s, FailureCode.ServerFull, 'servidor cheio');
    }

    const id = this.allocClientId();
    if (id === 0) return this.kick(s, FailureCode.ServerFull, 'sem ids disponiveis');

    s.id = id;
    s.nickname = this.uniqueNickname(clean(nickname, MAX_NICKNAME) || 'convidado');
    s.flags = ClientFlags.None;
    s.authenticated = true;
    this.pending.delete(s);
    this.sessions.set(id, s);
    this.nicknames.add(s.nickname.toLowerCase());

    s.send(
      encodeServerMessage({
        t: Op.Welcome,
        clientId: id,
        serverName: config.serverName,
        motd: config.motd,
      }),
    );

    const home = this.defaultChannel();
    if (home) {
      home.members.add(s);
      s.channelId = home.info.id;
    }

    s.send(
      encodeServerMessage({
        t: Op.Snapshot,
        channels: this.channelList,
        clients: this.clientList(),
      }),
    );
    this.broadcast({ t: Op.ClientAdd, client: describe(s) }, s);
  }

  private allocClientId(): number {
    for (let i = 0; i < 0xffff; i++) {
      const id = this.nextClientId;
      this.nextClientId = this.nextClientId >= 0xffff ? 1 : this.nextClientId + 1;
      if (!this.sessions.has(id)) return id;
    }
    return 0;
  }

  private uniqueNickname(base: string): string {
    if (!this.nicknames.has(base.toLowerCase())) return base;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base} (${i})`;
      if (!this.nicknames.has(candidate.toLowerCase())) return candidate;
    }
    return `${base} (${Date.now() % 10000})`;
  }

  private clientList(): ClientInfo[] {
    return [...this.sessions.values()].map(describe);
  }

  // --------------------------------------------------------- movimentacao --

  private joinChannel(s: Session, channelId: number, password: string): void {
    const target = this.channels.get(channelId);
    if (!target) return this.fail(s, FailureCode.ChannelNotFound, 'canal inexistente');
    if (s.channelId === channelId) return;
    if (target.password && target.password !== password) {
      return this.fail(s, FailureCode.BadPassword, 'senha do canal incorreta');
    }
    if (target.info.maxClients > 0 && target.members.size >= target.info.maxClients) {
      return this.fail(s, FailureCode.ChannelFull, 'canal cheio');
    }

    this.leaveChannel(s);
    target.members.add(s);
    s.channelId = channelId;
    this.broadcast({ t: Op.ClientMove, clientId: s.id, channelId });
  }

  /** Tira a sessao do canal atual e recolhe canais temporarios vazios. */
  private leaveChannel(s: Session): void {
    const old = this.channels.get(s.channelId);
    if (!old) return;
    old.members.delete(s);
    s.channelId = NO_CHANNEL;
    if (old.members.size === 0 && !(old.info.flags & ChannelFlags.Permanent)) {
      this.channels.delete(old.info.id);
      this.broadcast({ t: Op.ChannelRemove, channelId: old.info.id });
    }
  }

  private createChannel(
    s: Session,
    name: string,
    parentId: number,
    maxClients: number,
    password: string,
  ): void {
    const label = clean(name, 64);
    if (!label) return this.fail(s, FailureCode.Malformed, 'nome vazio');
    if (this.channels.size >= 512) return this.fail(s, FailureCode.NotPermitted, 'limite de canais');
    if (parentId !== NO_CHANNEL && !this.channels.has(parentId)) parentId = NO_CHANNEL;

    const info: ChannelInfo = {
      id: this.allocChannelId(),
      parentId,
      order: this.channels.size,
      name: label,
      topic: '',
      maxClients: clamp(maxClients, 0, 512),
      flags: password ? ChannelFlags.Password : ChannelFlags.None,
    };
    this.channels.set(info.id, { info, password, members: new Set() });
    this.broadcast({ t: Op.ChannelAdd, channel: info });
    this.joinChannel(s, info.id, password);
  }

  private deleteChannel(s: Session, channelId: number): void {
    const ch = this.channels.get(channelId);
    if (!ch) return this.fail(s, FailureCode.ChannelNotFound, 'canal inexistente');
    if (ch.info.flags & ChannelFlags.Default) {
      return this.fail(s, FailureCode.NotPermitted, 'o canal padrao nao pode ser removido');
    }
    const home = this.defaultChannel();
    for (const member of [...ch.members]) {
      ch.members.delete(member);
      if (home) {
        home.members.add(member);
        member.channelId = home.info.id;
        this.broadcast({ t: Op.ClientMove, clientId: member.id, channelId: home.info.id });
      }
    }
    this.channels.delete(channelId);
    this.broadcast({ t: Op.ChannelRemove, channelId });
    this.onChannelsChanged();
  }

  // ---------------------------------------------------------------- chat --

  private routeChat(s: Session, scope: ChatScope, targetId: number, text: string): void {
    const body = clean(text, MAX_CHAT_TEXT);
    if (!body) return;
    const frame = encodeServerMessage({
      t: Op.ChatDeliver,
      scope,
      senderId: s.id,
      senderName: s.nickname,
      text: body,
      stamp: Date.now(),
    });

    if (scope === ChatScope.Private) {
      const target = this.sessions.get(targetId);
      if (!target) return this.fail(s, FailureCode.Unknown, 'usuario offline');
      target.send(frame);
      s.send(frame);
      return;
    }
    if (scope === ChatScope.Channel) {
      const ch = this.channels.get(s.channelId);
      if (!ch) return;
      for (const m of ch.members) m.send(frame);
      return;
    }
    for (const m of this.sessions.values()) m.send(frame);
  }

  // --------------------------------------------------------------- saidas --

  private broadcast(m: ServerMessage, except?: Session): void {
    const frame = encodeServerMessage(m);
    for (const s of this.sessions.values()) {
      if (s !== except) s.send(frame);
    }
  }

  private fail(s: Session, code: FailureCode, message: string): void {
    s.send(encodeServerMessage({ t: Op.Failure, code, message }));
  }

  private kick(s: Session, code: FailureCode, message: string): void {
    this.fail(s, code, message);
    s.socket.close(message);
    this.drop(s);
  }
}

function describe(s: Session): ClientInfo {
  return { id: s.id, channelId: s.channelId, nickname: s.nickname, flags: s.flags };
}
