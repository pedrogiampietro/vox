/**
 * Um Hub e um servidor virtual: seus canais, seus clientes, seus grupos.
 *
 * Regra de ouro: o Hub nunca decodifica audio. Pacote de voz que chega e
 * carimbado com o id do remetente e reencaminhado como esta. Isso mantem o
 * custo por usuario em algumas centenas de bytes de estado e quase nenhum CPU.
 *
 * O handshake tem tres etapas porque identidade so vale se for provada:
 * Hello (quem digo que sou) -> Challenge (prove) -> Auth (assinatura). So
 * depois disso a sessao entra na lista e ganha o grupo da sua identidade.
 */

import {
  CHALLENGE_BYTES,
  ChannelFlags,
  ChatScope,
  ClientFlags,
  DEFAULT_GROUP_DEFS,
  FailureCode,
  FrameKind,
  GROUP_NAMES,
  Group,
  NO_CHANNEL,
  Op,
  PROTOCOL_VERSION,
  RemoveReason,
  VOICE_TOKEN_BYTES,
  decodeClientMessage,
  encodeServerMessage,
  stampSender,
  MAX_CHAT_TEXT,
  MAX_NICKNAME,
  MAX_VOICE_PACKET,
  VOICE_HEADER_SIZE,
} from '@vox/protocol';
import type { ChannelInfo, ClientInfo, ClientMessage, GroupDef, ServerMessage } from '@vox/protocol';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { fingerprintOf, looksLikePublicKey, verifyChallenge } from './identity.js';
import type { StoredBan, StoredBotConfig, StoredChannel, StoredServer } from './persistence.js';
import { DEFAULT_BOT_CONFIG } from './persistence.js';
import type { BotConfig } from '../../bot/src/bot.js';
import { Session, type PeerSocket, type VoiceSink } from './session.js';
import { clean, clamp } from './util.js';

export interface ServerSettings {
  id: number;
  slug: string;
  ownerId: number | null;
  name: string;
  motd: string;
  password: string;
  maxClients: number;
  adminPassword: string;
}

export interface HubDeps {
  /** Avisa que algo persistente mudou (canais, grupos, banimentos). */
  onChanged(): void;
  claimVoiceKey(key: string, session: Session): void;
  releaseVoiceKey(key: string): void;
  voiceEndpoint(): { port: number; certHash: Uint8Array };
}

interface Channel {
  info: ChannelInfo;
  password: string;
  members: Set<Session>;
}

/** Quem pode o que. Um lugar so, para nao espalhar regra pelo arquivo. */
const REQUIRED = {
  createChannel: Group.Guest,
  editChannel: Group.Moderator,
  deleteChannel: Group.Moderator,
  kick: Group.Moderator,
  move: Group.Moderator,
  ban: Group.Admin,
  setGroup: Group.Admin,
} as const;

export class Hub {
  private readonly channels = new Map<number, Channel>();
  private readonly sessions = new Map<number, Session>();
  /** Conexoes abertas que ainda nao terminaram o handshake. */
  private readonly pending = new Set<Session>();
  private readonly nicknames = new Set<string>();
  private readonly groups = new Map<string, Group>();
  private groupDefs: GroupDef[];
  private bans: StoredBan[] = [];

  afkEnabled = config.afkEnabled;

  /** Referencia ao bot Rubinot, quando ativo. */
  rubinot: {
    addHunted(n: string): void;
    removeHunted(n: string): void;
    huntedList: string[];
    isRunning: boolean;
    start(): Promise<void>;
    stop(): void;
    restart(cfg: BotConfig): Promise<void>;
    config: BotConfig;
  } | null = null;
  botConfig: StoredBotConfig;

  private nextClientId = 1;
  private nextChannelId = 1;

  constructor(
    public settings: ServerSettings,
    stored: Pick<StoredServer, 'channels' | 'groups' | 'bans' | 'groupDefs' | 'botConfig'>,
    private readonly deps: HubDeps,
  ) {
    for (const c of stored.channels) {
      const { password, ...info } = c;
      this.seedChannel(info, password);
    }
    for (const [fp, group] of Object.entries(stored.groups)) this.groups.set(fp, group);
    this.groupDefs = stored.groupDefs?.length ? [...stored.groupDefs] : [...DEFAULT_GROUP_DEFS];
    this.bans = [...stored.bans];
    this.botConfig = stored.botConfig ? { ...stored.botConfig } : { ...DEFAULT_BOT_CONFIG };
  }

  // ----------------------------------------------------------- inspecao --

  get id(): number {
    return this.settings.id;
  }

  get clientCount(): number {
    return this.sessions.size;
  }

  get channelList(): ChannelInfo[] {
    return [...this.channels.values()].map((c) => c.info);
  }

  clientList(): ClientInfo[] {
    return [...this.sessions.values()].map(describe);
  }

  banList(): StoredBan[] {
    this.pruneBans();
    return [...this.bans];
  }

  groupList(): Record<string, Group> {
    return Object.fromEntries(this.groups);
  }

  toStored(): StoredServer {
    const botHunted = this.rubinot ? this.rubinot.huntedList : this.botConfig.huntedNames;
    return {
      ...this.settings,
      channels: [...this.channels.values()]
        .filter((c) => c.info.flags & ChannelFlags.Permanent)
        .map((c): StoredChannel => ({ ...c.info, password: c.password })),
      groups: this.groupList(),
      bans: this.banList(),
      groupDefs: [...this.groupDefs],
      botConfig: { ...this.botConfig, huntedNames: botHunted },
    };
  }

  get groupDefList(): GroupDef[] {
    return this.groupDefs;
  }

  // ------------------------------------------------------------- canais --

  private seedChannel(info: ChannelInfo, password: string): void {
    this.channels.set(info.id, { info, password, members: new Set() });
    if (info.id >= this.nextChannelId) this.nextChannelId = info.id + 1;
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

  // -------------------------------------------------------- ciclo de vida --

  accept(socket: PeerSocket): Session {
    const s = new Session(socket, config.voicePacketsPerSecond, config.controlMessagesPerSecond);
    s.serverId = this.settings.id;
    this.pending.add(s);
    return s;
  }

  drop(s: Session, reason: RemoveReason = RemoveReason.Disconnected): void {
    this.pending.delete(s);
    if (!this.isLive(s)) return;

    this.leaveChannel(s);
    this.sessions.delete(s.id);
    this.nicknames.delete(s.nickname.toLowerCase());
    if (s.voiceKey) this.deps.releaseVoiceKey(s.voiceKey);
    s.voiceKey = '';
    s.voice?.close();
    s.voice = null;
    s.stage = 'new';
    this.broadcast({ t: Op.ClientRemove, clientId: s.id, reason });
  }

  private isLive(s: Session): boolean {
    return s.live && this.sessions.get(s.id) === s;
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

  private checkAfkOnMute(s: Session): void {
    if (!this.afkEnabled) return;
    const bothMuted = (s.flags & ClientFlags.MutedMic) !== 0
      && (s.flags & ClientFlags.MutedSpeakers) !== 0;
    if (!bothMuted) return;
    const afkCh = this.findOrCreateAfkChannel();
    if (!afkCh) return;
    if (s.channelId === afkCh.info.id) return;
    this.forceMove(s, afkCh.info.id);
  }

  private findOrCreateAfkChannel(): Channel | null {
    const name = config.afkChannelName;
    for (const ch of this.channels.values()) {
      if (ch.info.name === name) return ch;
    }
    const info: ChannelInfo = {
      id: this.allocChannelId(),
      parentId: NO_CHANNEL,
      order: this.channels.size,
      name,
      topic: 'Canal AFK',
      maxClients: 0,
      flags: ChannelFlags.Permanent,
    };
    this.channels.set(info.id, { info, password: '', members: new Set() });
    this.broadcast({ t: Op.ChannelAdd, channel: info });
    this.deps.onChanged();
    return this.channels.get(info.id) ?? null;
  }

  /** Fecha o servidor virtual inteiro; usado quando o painel o remove. */
  shutdown(reason: string): void {
    for (const s of [...this.pending, ...this.sessions.values()]) {
      this.fail(s, FailureCode.ServerNotFound, reason);
      s.socket.close(reason);
      this.drop(s, RemoveReason.ServerClosed);
    }
  }

  // ------------------------------------------------------------ entrada --

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

  // ---------------------------------------------------------------- voz --

  private routeVoice(s: Session, frame: Uint8Array): void {
    if (!this.isLive(s)) return;
    if (frame.length <= VOICE_HEADER_SIZE || frame.length > MAX_VOICE_PACKET) return;
    if (s.flags & ClientFlags.MutedMic) return;

    const channel = this.channels.get(s.channelId);
    if (!channel) return;

    if (channel.info.flags & ChannelFlags.Moderated) {
      if (s.group < Group.Moderator && !(s.flags & ClientFlags.HasVoice)) return;
    }

    stampSender(frame, s.id);
    for (const peer of channel.members) {
      if (peer === s) continue;
      if (peer.flags & ClientFlags.MutedSpeakers) continue;
      peer.sendVoice(frame);
    }
  }

  // ----------------------------------------------------------- controle --

  private handleControl(s: Session, m: ClientMessage): void {
    if (m.t === Op.Hello) return void this.handleHello(s, m);
    if (m.t === Op.Auth) return void this.handleAuth(s, m.signature);

    if (!this.isLive(s)) {
      this.kick(s, FailureCode.NotPermitted, 'handshake incompleto');
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
        // HasVoice e controlado pelo servidor (moderador), nao pelo cliente.
        flags = (flags & ~ClientFlags.HasVoice) | (s.flags & ClientFlags.HasVoice);
        if (flags !== s.flags) {
          s.flags = flags;
          this.broadcast({ t: Op.ClientState, clientId: s.id, flags });
          this.checkAfkOnMute(s);
        }
        if (m.nickname !== undefined) {
          const nick = clean(m.nickname, MAX_NICKNAME) || 'convidado';
          if (nick !== s.nickname) {
            s.nickname = nick;
            this.broadcast({ t: Op.ClientAdd, client: describe(s) });
          }
        }
        break;
      }

      case Op.JoinChannel:
        this.joinChannel(s, m.channelId, m.password);
        break;

      case Op.CreateChannel:
        if (!this.allow(s, REQUIRED.createChannel)) break;
        this.createChannel(s, m.name, m.parentId, m.maxClients, m.password);
        break;

      case Op.DeleteChannel:
        if (!this.allow(s, REQUIRED.deleteChannel)) break;
        this.deleteChannel(s, m.channelId);
        break;

      case Op.EditChannel: {
        if (!this.allow(s, REQUIRED.editChannel)) break;
        const ch = this.channels.get(m.channelId);
        if (!ch) return this.fail(s, FailureCode.ChannelNotFound, 'canal inexistente');
        ch.info.name = clean(m.name, 64) || ch.info.name;
        ch.info.topic = clean(m.topic, 128);
        ch.info.maxClients = clamp(m.maxClients, 0, 512);
        this.broadcast({ t: Op.ChannelUpdate, channel: ch.info });
        this.deps.onChanged();
        break;
      }

      case Op.ChatSend:
        this.routeChat(s, m.scope, m.targetId, m.text);
        break;

      case Op.KickClient: {
        const target = this.targetFor(s, m.clientId, REQUIRED.kick);
        if (target) this.expel(target, RemoveReason.Kicked, clean(m.reason, 120) || 'expulso');
        break;
      }

      case Op.BanClient: {
        const target = this.targetFor(s, m.clientId, REQUIRED.ban);
        if (target) this.banSession(target, m.minutes, clean(m.reason, 120) || 'banido');
        break;
      }

      case Op.MoveClient: {
        const target = this.targetForMove(s, m.clientId);
        if (target) this.forceMove(target, m.channelId);
        break;
      }

      case Op.SetClientGroup: {
        const target = this.targetFor(s, m.clientId, REQUIRED.setGroup);
        if (!target) break;
        // Ninguem promove alguem ao proprio nivel ou acima: seria escada
        // para o topo em dois passos.
        if (m.group >= s.group) {
          return this.fail(s, FailureCode.NotPermitted, 'grupo acima do seu');
        }
        this.assignGroup(target, m.group);
        break;
      }

      case Op.SetGroupDef: {
        if (s.group < Group.Owner) {
          return this.fail(s, FailureCode.NotPermitted, 'apenas donos podem editar grupos');
        }
        const def: GroupDef = { id: m.group, name: clean(m.name, 32) || 'Grupo', icon: m.icon, color: clean(m.color, 9) };
        const idx = this.groupDefs.findIndex((g) => g.id === m.group);
        if (idx >= 0) this.groupDefs[idx] = def;
        else this.groupDefs.push(def);
        this.broadcast({ t: Op.GroupDefs, groups: this.groupDefs });
        this.deps.onChanged();
        break;
      }

      case Op.BotCommand: {
        this.handleBotCommand(s, m.command, m.args);
        break;
      }
    }
  }

  // --------------------------------------------------------- handshake --

  private async handleHello(s: Session, m: ClientMessage & { t: Op.Hello }): Promise<void> {
    if (s.stage !== 'new') return this.kick(s, FailureCode.NotPermitted, 'handshake repetido');
    if (m.version !== PROTOCOL_VERSION) {
      return this.kick(s, FailureCode.VersionMismatch, `servidor fala a versao ${PROTOCOL_VERSION}`);
    }
    if (this.settings.password && m.password !== this.settings.password &&
        m.password !== this.settings.adminPassword) {
      return this.kick(s, FailureCode.BadPassword, 'senha incorreta');
    }
    if (this.sessions.size >= this.settings.maxClients) {
      return this.kick(s, FailureCode.ServerFull, 'servidor cheio');
    }
    if (!looksLikePublicKey(m.publicKey)) {
      return this.kick(s, FailureCode.NotPermitted, 'identidade obrigatoria');
    }

    // Marca antes de qualquer await: outra mensagem que chegue no meio disto
    // ja encontra a sessao fora do estado `new`.
    s.stage = 'challenged';
    s.publicKey = m.publicKey;
    s.wantedNickname = clean(m.nickname, MAX_NICKNAME) || 'convidado';
    s.platform = clean(m.platform, 32) || 'Web';

    // Admin password: quem manda a senha de admin vira dono.
    s.adminLogin = Boolean(this.settings.adminPassword && m.password === this.settings.adminPassword);

    let fingerprint: string;
    try {
      fingerprint = await fingerprintOf(m.publicKey);
    } catch {
      return this.kick(s, FailureCode.NotPermitted, 'chave publica invalida');
    }
    s.fingerprint = fingerprint;

    const ban = this.banFor(fingerprint);
    if (ban) {
      const until = ban.until === 0 ? 'permanente' : new Date(ban.until).toISOString();
      return this.kick(s, FailureCode.Banned, `banido (${until}): ${ban.reason}`);
    }

    s.nonce = Uint8Array.from(randomBytes(CHALLENGE_BYTES));
    s.send(encodeServerMessage({ t: Op.Challenge, nonce: s.nonce }));
  }

  private async handleAuth(s: Session, signature: Uint8Array): Promise<void> {
    if (s.stage !== 'challenged' || s.nonce.length === 0) {
      return this.kick(s, FailureCode.NotPermitted, 'desafio ausente');
    }
    // Consome o desafio: cada nonce serve para uma assinatura so.
    const nonce = s.nonce;
    s.nonce = new Uint8Array(0);

    const ok = await verifyChallenge(s.publicKey, signature, nonce);
    if (!ok) return this.kick(s, FailureCode.BadSignature, 'assinatura invalida');
    if (s.stage !== 'challenged') return; // caiu enquanto verificava

    this.admit(s);
  }

  /** Identidade provada: a sessao entra na lista e ganha seu grupo. */
  private admit(s: Session): void {
    const id = this.allocClientId();
    if (id === 0) return this.kick(s, FailureCode.ServerFull, 'sem ids disponiveis');

    s.id = id;
    s.nickname = this.uniqueNickname(s.wantedNickname);
    s.flags = ClientFlags.None;
    s.group = this.groupFor(s.fingerprint, s.adminLogin);
    s.stage = 'live';
    this.pending.delete(s);
    this.sessions.set(id, s);
    this.nicknames.add(s.nickname.toLowerCase());

    const token = new Uint8Array(randomBytes(VOICE_TOKEN_BYTES));
    s.voiceKey = Buffer.from(token).toString('hex');
    this.deps.claimVoiceKey(s.voiceKey, s);

    const voice = this.deps.voiceEndpoint();
    s.send(
      encodeServerMessage({
        t: Op.Welcome,
        clientId: id,
        serverId: this.settings.id,
        serverName: this.settings.name,
        motd: this.settings.motd,
        group: s.group,
        voiceToken: token,
        wtPort: voice.port,
        wtCertHash: voice.certHash,
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
    s.send(encodeServerMessage({ t: Op.GroupDefs, groups: this.groupDefs }));
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

  // ------------------------------------------------------------- grupos --

  /**
   * O primeiro a chegar num servidor sem dono vira dono.
   *
   * Alguem precisa poder configurar o servidor no primeiro dia, e distribuir
   * senha de admin por fora seria pior. Depois disso, so o dono promove.
   */
  private groupFor(fingerprint: string, adminLogin = false): Group {
    if (adminLogin) {
      const known = this.groups.get(fingerprint);
      if (known !== undefined && known >= Group.Owner) return known;
      this.groups.set(fingerprint, Group.Owner);
      this.deps.onChanged();
      console.log(`[vox] servidor ${this.settings.id}: ${fingerprint.slice(0, 12)} virou dono (admin login)`);
      return Group.Owner;
    }

    const known = this.groups.get(fingerprint);
    if (known !== undefined) return known;

    for (const g of this.groups.values()) if (g === Group.Owner) return Group.Guest;

    this.groups.set(fingerprint, Group.Owner);
    this.deps.onChanged();
    console.log(`[vox] servidor ${this.settings.id}: ${fingerprint.slice(0, 12)} virou dono`);
    return Group.Owner;
  }

  private assignGroup(target: Session, group: Group): void {
    if (group === Group.Guest) this.groups.delete(target.fingerprint);
    else this.groups.set(target.fingerprint, group);
    target.group = group;
    this.deps.onChanged();
    // ClientAdd tambem serve de atualizacao: o cliente indexa por id.
    this.broadcast({ t: Op.ClientAdd, client: describe(target) });
  }

  /** Define o grupo de uma identidade que pode nem estar online. */
  setGroupByFingerprint(fingerprint: string, group: Group): void {
    if (group === Group.Guest) this.groups.delete(fingerprint);
    else this.groups.set(fingerprint, group);
    for (const s of this.sessions.values()) {
      if (s.fingerprint !== fingerprint) continue;
      s.group = group;
      this.broadcast({ t: Op.ClientAdd, client: describe(s) });
    }
    this.deps.onChanged();
  }

  private allow(s: Session, required: Group): boolean {
    if (s.group >= required) return true;
    this.fail(s, FailureCode.NotPermitted, 'permissao insuficiente');
    return false;
  }

  /** Resolve o alvo de uma acao de moderacao, checando poder e hierarquia. */
  private targetFor(actor: Session, clientId: number, required: Group): Session | null {
    if (!this.allow(actor, required)) return null;
    const target = this.sessions.get(clientId);
    if (!target) {
      this.fail(actor, FailureCode.Unknown, 'usuario nao esta online');
      return null;
    }
    if (target === actor) {
      this.fail(actor, FailureCode.NotPermitted, 'acao sobre si mesmo');
      return null;
    }
    if (target.group > actor.group) {
      this.fail(actor, FailureCode.NotPermitted, 'alvo de grupo superior');
      return null;
    }
    return target;
  }

  /** Move permite mesmo nivel: Owner move Owner, Admin move Admin. */
  private targetForMove(actor: Session, clientId: number): Session | null {
    if (!this.allow(actor, REQUIRED.move)) return null;
    const target = this.sessions.get(clientId);
    if (!target) {
      this.fail(actor, FailureCode.Unknown, 'usuario nao esta online');
      return null;
    }
    if (target === actor) {
      this.fail(actor, FailureCode.NotPermitted, 'acao sobre si mesmo');
      return null;
    }
    if (target.group > actor.group) {
      this.fail(actor, FailureCode.NotPermitted, 'alvo de grupo superior');
      return null;
    }
    return target;
  }

  // -------------------------------------------------------- banimentos --

  private pruneBans(): void {
    const now = Date.now();
    this.bans = this.bans.filter((b) => b.until === 0 || b.until > now);
  }

  private banFor(fingerprint: string): StoredBan | null {
    this.pruneBans();
    return this.bans.find((b) => b.fingerprint === fingerprint) ?? null;
  }

  private addBan(fingerprint: string, minutes: number, reason: string): void {
    if (!fingerprint) return;
    this.bans = this.bans.filter((b) => b.fingerprint !== fingerprint);
    this.bans.push({
      fingerprint,
      until: minutes === 0 ? 0 : Date.now() + minutes * 60_000,
      reason,
    });
    this.deps.onChanged();
  }

  removeBan(fingerprint: string): boolean {
    const before = this.bans.length;
    this.bans = this.bans.filter((b) => b.fingerprint !== fingerprint);
    if (this.bans.length === before) return false;
    this.deps.onChanged();
    return true;
  }

  // -------------------------------------------------------- moderacao --

  /** Registra o banimento e derruba a sessao. Teto de um ano; 0 = permanente. */
  banSession(target: Session, minutes: number, reason: string): void {
    this.addBan(target.fingerprint, clamp(minutes, 0, 60 * 24 * 365), reason);
    this.expel(target, RemoveReason.Banned, reason);
  }

  /** Expulsa a sessao, avisando o motivo antes de fechar. */
  expel(target: Session, reason: RemoveReason, message: string): void {
    this.fail(target, reason === RemoveReason.Banned ? FailureCode.Banned : FailureCode.NotPermitted, message);
    target.socket.close(message);
    this.drop(target, reason);
  }

  forceMove(target: Session, channelId: number): void {
    if (!this.channels.has(channelId)) return;
    this.leaveChannel(target);
    const ch = this.channels.get(channelId)!;
    ch.members.add(target);
    target.channelId = channelId;
    this.broadcast({ t: Op.ClientMove, clientId: target.id, channelId });
  }

  /** Usado pelo painel, que ja se autenticou por fora. */
  sessionById(clientId: number): Session | undefined {
    return this.sessions.get(clientId);
  }

  // ------------------------------------------------------ movimentacao --

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
    if (s.flags & ClientFlags.HasVoice) {
      s.flags &= ~ClientFlags.HasVoice;
      this.broadcast({ t: Op.ClientState, clientId: s.id, flags: s.flags });
    }
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

    // Canal de convidado e sempre temporario: some quando esvazia. So quem
    // modera cria canal que fica.
    const permanent = s.group >= Group.Moderator ? ChannelFlags.Permanent : ChannelFlags.None;
    const info: ChannelInfo = {
      id: this.allocChannelId(),
      parentId,
      order: this.channels.size,
      name: label,
      topic: '',
      maxClients: clamp(maxClients, 0, 512),
      flags: (password ? ChannelFlags.Password : ChannelFlags.None) | permanent,
    };
    this.channels.set(info.id, { info, password, members: new Set() });
    this.broadcast({ t: Op.ChannelAdd, channel: info });
    if (permanent) this.deps.onChanged();
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
    this.deps.onChanged();
  }

  // ----------------------------------------------------------------- chat --

  private routeChat(s: Session, scope: ChatScope, targetId: number, text: string): void {
    const body = clean(text, MAX_CHAT_TEXT);
    if (!body) return;

    const frame = encodeServerMessage({
      t: Op.ChatDeliver,
      scope,
      senderId: s.id,
      targetId,
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

  // -------------------------------------------------------- bot commands --

  private handleBotCommand(s: Session, command: string, args: string[]): void {
    const cmd = command.toLowerCase();
    const minGroup = this.getRequiredGroupForBotCommand(cmd);

    if (s.group < minGroup) {
      this.sendBotResult(s, false, `permite: ${GROUP_NAMES[minGroup]}+`);
      return;
    }

    switch (cmd) {
      case 'poke': {
        if (args.length < 1) return this.sendBotResult(s, false, 'uso: poke <nick> [mensagem]');
        const nick = args[0];
        if (!nick) return this.sendBotResult(s, false, 'uso: poke <nick> [mensagem]');
        const target = this.findClientByNick(nick);
        if (!target) return this.sendBotResult(s, false, 'usuario nao encontrado');
        const pokeMsg = args.slice(1).join(' ') || '';
        this.sendBotResult(s, true, `poke enviado para ${target.nickname}`);
        target.send(encodeServerMessage({
          t: Op.ChatDeliver,
          scope: ChatScope.Private,
          senderId: 0,
          targetId: target.id,
          senderName: 'bot',
          text: pokeMsg
            ? `👉 ${s.nickname} te cutucou: ${pokeMsg}`
            : `👉 ${s.nickname} te cutucou!`,
          stamp: Date.now(),
        }));
        break;
      }
      case 'masspoke': {
        const massPokeMsg = args.join(' ') || '';
        let pokeCount = 0;
        for (const m of this.sessions.values()) {
          if (m.id !== s.id) {
            pokeCount++;
            m.send(encodeServerMessage({
              t: Op.ChatDeliver,
              scope: ChatScope.Private,
              senderId: 0,
              targetId: m.id,
              senderName: 'bot',
              text: massPokeMsg
                ? `👉 ${s.nickname} cutucou todo mundo: ${massPokeMsg}`
                : `👉 ${s.nickname} cutucou todo mundo!`,
              stamp: Date.now(),
            }));
          }
        }
        this.sendBotResult(s, true, `poke em massa enviado (${pokeCount} usuarios)`);
        break;
      }
      case 'push': {
        if (args.length < 2) return this.sendBotResult(s, false, 'uso: push <nick> <canal>');
        const targetNick = args[0];
        const channelName = args[1];
        if (!targetNick || !channelName) return this.sendBotResult(s, false, 'uso: push <nick> <canal>');
        const target = this.findClientByNick(targetNick);
        if (!target) return this.sendBotResult(s, false, 'usuario nao encontrado');
        const destChannel = this.findChannelObjByName(channelName);
        if (!destChannel) return this.sendBotResult(s, false, 'canal nao encontrado');
        if (!this.canEnter(target, destChannel)) return this.sendBotResult(s, false, 'usuario nao pode entrar neste canal');
        this.joinChannel(target, destChannel.info.id, '');
        this.sendBotResult(s, true, `${target.nickname} movido para ${destChannel.info.name}`);
        break;
      }
      case 'masspush': {
        if (args.length < 1) return this.sendBotResult(s, false, 'uso: masspush <destino> [origem]');
        const destChannelName = args[0];
        if (!destChannelName) return this.sendBotResult(s, false, 'uso: masspush <destino> [origem]');
        const destChannel = this.findChannelObjByName(destChannelName);
        if (!destChannel) return this.sendBotResult(s, false, 'canal destino nao encontrado');
        let sources: Session[];
        if (args[1]) {
          const srcChannel = this.findChannelObjByName(args[1]);
          if (!srcChannel) return this.sendBotResult(s, false, 'canal origem nao encontrado');
          sources = [...srcChannel.members];
        } else {
          sources = [...this.sessions.values()];
        }
        let count = 0;
        for (const m of sources) {
          if (m.id !== s.id && m.channelId !== destChannel.info.id && this.canEnter(m, destChannel)) {
            this.joinChannel(m, destChannel.info.id, '');
            count++;
          }
        }
        this.sendBotResult(s, true, `${count} usuarios movidos para ${destChannel.info.name}`);
        break;
      }
      case 'kick': {
        if (args.length < 1) return this.sendBotResult(s, false, 'uso: kick <nick> [motivo]');
        const targetNick = args[0];
        if (!targetNick) return this.sendBotResult(s, false, 'uso: kick <nick> [motivo]');
        const target = this.findClientByNick(targetNick);
        if (!target) return this.sendBotResult(s, false, 'usuario nao encontrado');
        const reason = args.slice(1).join(' ') || 'expulso por bot';
        this.expel(target, RemoveReason.Kicked, reason);
        this.sendBotResult(s, true, `${target.nickname} expulso`);
        break;
      }
      case 'masskick': {
        const channel = this.channels.get(s.channelId);
        if (!channel) return this.sendBotResult(s, false, 'voce nao esta em um canal');
        const reason = args.join(' ') || 'expulso por bot';
        let count = 0;
        for (const m of channel.members) {
          if (m.id !== s.id) {
            this.expel(m, RemoveReason.Kicked, reason);
            count++;
          }
        }
        this.sendBotResult(s, true, `${count} usuarios expulsos`);
        break;
      }
      case 'ban': {
        if (args.length < 1) return this.sendBotResult(s, false, 'uso: ban <nick> [minutos] [motivo]');
        const targetNick = args[0];
        if (!targetNick) return this.sendBotResult(s, false, 'uso: ban <nick> [minutos] [motivo]');
        const target = this.findClientByNick(targetNick);
        if (!target) return this.sendBotResult(s, false, 'usuario nao encontrado');
        const minutes = Number(args[1]) || 60;
        const reason = args.slice(2).join(' ') || 'banido por bot';
        this.banSession(target, minutes, reason);
        this.sendBotResult(s, true, `${target.nickname} banido por ${minutes}min`);
        break;
      }
      case 'mute': {
        if (args.length < 1) return this.sendBotResult(s, false, 'uso: mute <nick>');
        const targetNick = args[0];
        if (!targetNick) return this.sendBotResult(s, false, 'uso: mute <nick>');
        const target = this.findClientByNick(targetNick);
        if (!target) return this.sendBotResult(s, false, 'usuario nao encontrado');
        target.flags |= ClientFlags.MutedMic;
        this.broadcast({ t: Op.ClientState, clientId: target.id, flags: target.flags });
        this.sendBotResult(s, true, `${target.nickname} silenciado`);
        break;
      }
      case 'unmute': {
        if (args.length < 1) return this.sendBotResult(s, false, 'uso: unmute <nick>');
        const targetNick = args[0];
        if (!targetNick) return this.sendBotResult(s, false, 'uso: unmute <nick>');
        const target = this.findClientByNick(targetNick);
        if (!target) return this.sendBotResult(s, false, 'usuario nao encontrado');
        target.flags &= ~ClientFlags.MutedMic;
        this.broadcast({ t: Op.ClientState, clientId: target.id, flags: target.flags });
        this.sendBotResult(s, true, `${target.nickname} desilenciado`);
        break;
      }
      case 'moderate': {
        const channel = this.channels.get(s.channelId);
        if (!channel) return this.sendBotResult(s, false, 'voce nao esta em um canal');
        const wasModerated = (channel.info.flags & ChannelFlags.Moderated) !== 0;
        if (wasModerated) {
          channel.info.flags &= ~ChannelFlags.Moderated;
          // remove HasVoice de todos no canal
          for (const m of channel.members) {
            if (m.flags & ClientFlags.HasVoice) {
              m.flags &= ~ClientFlags.HasVoice;
              this.broadcast({ t: Op.ClientState, clientId: m.id, flags: m.flags });
            }
          }
        } else {
          channel.info.flags |= ChannelFlags.Moderated;
        }
        this.broadcast({ t: Op.ChannelUpdate, channel: channel.info });
        this.sendBotResult(s, true, wasModerated
          ? `canal ${channel.info.name} desmoderando`
          : `canal ${channel.info.name} agora é moderado — só Moderator+ e quem tiver voice podem falar`);
        break;
      }
      case 'voice': {
        if (args.length < 1) return this.sendBotResult(s, false, 'uso: voice <nick>');
        const targetNick = args[0];
        if (!targetNick) return this.sendBotResult(s, false, 'uso: voice <nick>');
        const target = this.findClientByNick(targetNick);
        if (!target) return this.sendBotResult(s, false, 'usuario nao encontrado');
        if (target.flags & ClientFlags.HasVoice) return this.sendBotResult(s, false, `${target.nickname} ja tem voice`);
        target.flags |= ClientFlags.HasVoice;
        this.broadcast({ t: Op.ClientState, clientId: target.id, flags: target.flags });
        this.sendBotResult(s, true, `${target.nickname} agora pode falar`);
        break;
      }
      case 'devoice': {
        if (args.length < 1) return this.sendBotResult(s, false, 'uso: devoice <nick>');
        const targetNick = args[0];
        if (!targetNick) return this.sendBotResult(s, false, 'uso: devoice <nick>');
        const target = this.findClientByNick(targetNick);
        if (!target) return this.sendBotResult(s, false, 'usuario nao encontrado');
        if (!(target.flags & ClientFlags.HasVoice)) return this.sendBotResult(s, false, `${target.nickname} nao tem voice`);
        target.flags &= ~ClientFlags.HasVoice;
        this.broadcast({ t: Op.ClientState, clientId: target.id, flags: target.flags });
        this.sendBotResult(s, true, `${target.nickname} perdeu a permissao de falar`);
        break;
      }
      case 'afk': {
        this.afkEnabled = !this.afkEnabled;
        this.sendBotResult(s, true, this.afkEnabled ? 'afk automatico ligado' : 'afk automatico desligado');
        break;
      }
      case 'banlist': {
        this.pruneBans();
        if (this.bans.length === 0) return this.sendBotResult(s, true, 'nenhum ban ativo');
        const lines = this.bans.map((b) => {
          const fp = b.fingerprint.slice(0, 12) + '…';
          const until = b.until === 0 ? 'permanente' : new Date(b.until).toLocaleString('pt-BR');
          return `${fp}  ${until}  ${b.reason}`;
        });
        this.sendBotResult(s, true, `bans ativos (${this.bans.length}):\n${lines.join('\n')}`);
        break;
      }
      case 'unban': {
        if (args.length < 1) return this.sendBotResult(s, false, 'uso: unban <fingerprint>');
        const prefix = args[0]!.toLowerCase();
        const match = this.bans.find((b) => b.fingerprint.toLowerCase().startsWith(prefix));
        if (!match) return this.sendBotResult(s, false, 'ban nao encontrado');
        this.removeBan(match.fingerprint);
        this.sendBotResult(s, true, `ban removido: ${match.fingerprint.slice(0, 12)}… (${match.reason})`);
        break;
      }
      case 'owner': {
        if (!this.settings.adminPassword) {
          return this.sendBotResult(s, false, 'senha de admin nao configurada no servidor.');
        }
        if (args.length < 1) return this.sendBotResult(s, false, 'uso: /owner <senha>');
        if (args[0] !== this.settings.adminPassword) {
          return this.sendBotResult(s, false, 'senha incorreta.');
        }
        if (s.group >= Group.Owner) {
          return this.sendBotResult(s, false, 'voce ja e dono.');
        }
        this.assignGroup(s, Group.Owner);
        this.sendBotResult(s, true, 'voce agora e dono do servidor.');
        console.log(`[vox] servidor ${this.settings.id}: ${s.fingerprint.slice(0, 12)} virou dono via /owner`);
        break;
      }
      case 'hunt': {
        if (!this.rubinot) return this.sendBotResult(s, false, 'bot rubinot nao esta ativo');
        if (args.length < 1) return this.sendBotResult(s, false, 'uso: hunt <nome>');
        const name = args.join(' ');
        this.rubinot.addHunted(name);
        this.sendBotResult(s, true, `${name} adicionado a hunted list`);
        break;
      }
      case 'unhunt': {
        if (!this.rubinot) return this.sendBotResult(s, false, 'bot rubinot nao esta ativo');
        if (args.length < 1) return this.sendBotResult(s, false, 'uso: unhunt <nome>');
        const name = args.join(' ');
        this.rubinot.removeHunted(name);
        this.sendBotResult(s, true, `${name} removido da hunted list`);
        break;
      }
      case 'hunted': {
        if (!this.rubinot) return this.sendBotResult(s, false, 'bot rubinot nao esta ativo');
        const list = this.rubinot.huntedList;
        if (list.length === 0) return this.sendBotResult(s, true, 'hunted list vazia');
        this.sendBotResult(s, true, `hunted list (${list.length}):\n${list.join('\n')}`);
        break;
      }
      default:
        this.sendBotResult(s, false, `comando desconhecido: ${command}`);
    }
  }

  private getRequiredGroupForBotCommand(cmd: string): Group {
    switch (cmd) {
      case 'owner': return Group.Guest;
      case 'poke': return Group.Guest;
      case 'masspoke': return Group.Moderator;
      case 'push': return Group.Moderator;
      case 'masspush': return Group.Admin;
      case 'kick': return Group.Moderator;
      case 'masskick': return Group.Admin;
      case 'ban': return Group.Admin;
      case 'banlist': return Group.Admin;
      case 'unban': return Group.Admin;
      case 'afk': return Group.Admin;
      case 'mute': return Group.Moderator;
      case 'unmute': return Group.Moderator;
      case 'moderate': return Group.Moderator;
      case 'voice': return Group.Moderator;
      case 'devoice': return Group.Moderator;
      case 'hunt': return Group.Moderator;
      case 'unhunt': return Group.Moderator;
      case 'hunted': return Group.Guest;
      default: return Group.Owner;
    }
  }

  private findClientByNick(nick: string): Session | undefined {
    const lower = nick.toLowerCase();
    for (const s of this.sessions.values()) {
      if (s.nickname.toLowerCase() === lower) return s;
    }
    return undefined;
  }

  private findChannelObjByName(name: string): Channel | undefined {
    const lower = name.toLowerCase();
    for (const ch of this.channels.values()) {
      if (ch.info.name.toLowerCase() === lower) return ch;
    }
    return undefined;
  }

  private canEnter(target: Session, channel: Channel): boolean {
    if (channel.info.maxClients > 0 && channel.members.size >= channel.info.maxClients) return false;
    if (channel.password && !target.flags) return false; // simplified
    return true;
  }

  private sendBotResult(s: Session, success: boolean, message: string): void {
    s.send(encodeServerMessage({
      t: Op.BotCommandResult,
      success,
      message,
    }));
  }

  private whisper(s: Session, text: string): void {
    s.send(encodeServerMessage({
      t: Op.ChatDeliver,
      scope: ChatScope.Private,
      senderId: 0,
      targetId: s.id,
      senderName: 'servidor',
      text,
      stamp: Date.now(),
    }));
  }

  // --------------------------------------------------------------- saidas --

  /** Aviso do sistema no chat, usado por acoes do painel. */
  announce(text: string): void {
    const frame = encodeServerMessage({
      t: Op.ChatDeliver,
      scope: ChatScope.Server,
      senderId: 0,
      targetId: 0,
      senderName: 'servidor',
      text,
      stamp: Date.now(),
    });
    for (const s of this.sessions.values()) s.send(frame);
  }

  /** Envia mensagem de bot marcada para um canal, visivel para todo o servidor. */
  channelAnnounce(channelId: number, sender: string, text: string): void {
    const ch = this.channels.get(channelId);
    if (!ch) return;
    const frame = encodeServerMessage({
      t: Op.ChatDeliver,
      scope: ChatScope.Channel,
      senderId: 0,
      targetId: channelId,
      senderName: sender,
      text,
      stamp: Date.now(),
    });
    for (const s of this.sessions.values()) s.send(frame);
  }

  /** Encontra canal pelo nome (primeiro match, case-insensitive). */
  findChannelByName(name: string): number | undefined {
    const lower = name.toLowerCase();
    for (const [id, ch] of this.channels) {
      if (ch.info.name.toLowerCase() === lower) return id;
    }
    return undefined;
  }

  /**
   * Garante que um canal com o nome dado exista. Se nao existir, cria um canal
   * permanente na raiz (para o bot postar notificacoes).
   */
  ensureChannel(name: string): number {
    const existing = this.findChannelByName(name);
    if (existing !== undefined) return existing;
    const label = clean(name, 64) || 'bot';
    const info: ChannelInfo = {
      id: this.allocChannelId(),
      parentId: NO_CHANNEL,
      order: this.channels.size,
      name: label,
      topic: '',
      maxClients: 0,
      flags: ChannelFlags.Permanent,
    };
    this.channels.set(info.id, { info, password: '', members: new Set() });
    this.broadcast({ t: Op.ChannelAdd, channel: info });
    this.deps.onChanged();
    return info.id;
  }

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
  return {
    id: s.id,
    channelId: s.channelId,
    nickname: s.nickname,
    flags: s.flags,
    group: s.group,
    fingerprint: s.fingerprint,
    connectedAt: s.connectedAt,
    platform: s.platform,
  };
}
