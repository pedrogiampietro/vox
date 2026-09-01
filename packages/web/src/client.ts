/**
 * Cliente Vox: junta conexao, identidade, microfone e reproducao, e mantem uma
 * copia do estado do servidor. A interface le esse estado e chama os metodos
 * daqui - nao conhece protocolo nem Web Audio.
 */

import { ChannelFlags, ChatScope, ClientFlags, DEFAULT_GROUP_DEFS, FailureCode, Group, NO_CHANNEL, Op } from '@vox/protocol';
import type { ChannelInfo, ClientInfo, GroupDef, ServerMessage } from '@vox/protocol';
import { Connection, type LinkState, type Target } from './net/connection.js';
import { DEFAULT_MIC, Microphone, type MicSettings } from './audio/microphone.js';
import { VoiceMixer } from './audio/mixer.js';
import { Sounds, type SoundName } from './audio/sounds.js';
import { loadIdentity, type Identity } from './identity.js';
import { loadAudioPrefs, saveAudioPrefs, type AudioPrefs } from './audio-prefs.js';
import { touchFavorite, type Favorite } from './favorites.js';
import { notifications } from './notifications.js';

export interface ChatLine {
  scope: ChatScope;
  senderId: number;
  targetId: number;
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
const VOLUME_KEY = 'vox.peers';

/** Preferencias de audio por identidade, nao por sessao: o id muda, a pessoa nao. */
interface PeerPrefs {
  volume: number;
  muted: boolean;
}

export interface DmTab {
  clientId: number;
  name: string;
  unread: number;
}

export class VoxClient {
  readonly channels = new Map<number, ChannelInfo>();
  readonly clients = new Map<number, ClientInfo>();
  readonly chat: ChatLine[] = [];
  notice: Notice | null = null;
  /** Mensagens que chegaram com o chat fora de foco. */
  unread = 0;

  /** Abas de conversa privada abertas, por clientId do outro usuario. */
  readonly dmTabs = new Map<number, DmTab>();
  /** Aba ativa: null = canal, numero = DM com esse clientId. */
  activeDmTab: number | null = null;

  link: LinkState = 'offline';
  detail = '';
  serverName = '';
  motd = '';
  serverId = 0;
  selfId = 0;
  myGroup: Group = Group.Guest;

  identity: Identity | null = null;
  favorite: Favorite | null = null;

  groupDefs: GroupDef[] = [...DEFAULT_GROUP_DEFS];
  mic: MicSettings = { ...DEFAULT_MIC };
  outputVolume = 1;
  soundsEnabled = true;
  preamp = 1;
  notificationsEnabled = true;
  onPoke: ((from: string, text: string) => void) | null = null;
  onBotResult: ((message: string) => void) | null = null;

  private audioPrefs: AudioPrefs | null = null;

  private ctx: AudioContext | null = null;
  private workletsReady: Promise<void> | null = null;
  private mixer: VoiceMixer | null = null;
  private sounds: Sounds | null = null;
  private readonly peers = new Map<string, PeerPrefs>();

  readonly connection: Connection;
  readonly microphone: Microphone;

  constructor(private readonly onChange: () => void) {
    this.peers = loadPeerPrefs();
    this.connection = new Connection({
      onState: (link, detail) => {
        const wasOnline = this.link === 'online';
        this.link = link;
        this.detail = detail;
        if (link === 'offline') this.reset();
        // Reconectando: cala o audio mas deixa a arvore na tela, senao a
        // interface pisca vazia a cada oscilacao de rede.
        if (link === 'connecting') this.suspend();
        if (wasOnline && link !== 'online') this.play('lost');
        this.onChange();
      },
      onMessage: (m) => this.apply(m),
      onVoice: (p) => this.mixer?.push(p),
    });
    this.microphone = new Microphone((frame) => this.connection.sendVoice(frame));
  }

  // ------------------------------------------------------------ consultas --

  get self(): ClientInfo | undefined {
    return this.clients.get(this.selfId);
  }

  get flags(): number {
    return this.self?.flags ?? 0;
  }

  get micLevel(): number {
    return this.microphone.level;
  }

  isVoiceSilenced(c: ClientInfo): boolean {
    const ch = this.channels.get(c.channelId);
    if (!ch || !(ch.flags & ChannelFlags.Moderated)) return false;
    return c.group < Group.Moderator && !(c.flags & ClientFlags.HasVoice);
  }

  isTalking(clientId: number): boolean {
    if (clientId === this.selfId) {
      if (!this.microphone.transmitting) return false;
      const me = this.self;
      if (me && this.isVoiceSilenced(me)) return false;
      return true;
    }
    return this.mixer?.isTalking(clientId) ?? false;
  }

  membersOf(channelId: number): ClientInfo[] {
    return [...this.clients.values()]
      .filter((c) => c.channelId === channelId)
      .sort((a, b) => b.group - a.group || a.nickname.localeCompare(b.nickname));
  }

  childrenOf(parentId: number): ChannelInfo[] {
    return [...this.channels.values()]
      .filter((c) => c.parentId === parentId)
      .sort((a, b) => a.order - b.order || a.id - b.id);
  }

  /** Pode agir sobre este usuario? Espelha a regra do servidor, para a UI. */
  canModerate(target: ClientInfo, required: Group): boolean {
    if (target.id === this.selfId) return false;
    return this.myGroup >= required && this.myGroup >= target.group;
  }

  /** Pode mover este usuario? Mesmo nivel pode mover mesmo nivel. */
  canMove(target: ClientInfo): boolean {
    if (target.id === this.selfId) return true;
    return this.myGroup >= Group.Moderator && this.myGroup >= target.group;
  }

  groupDef(group: Group): GroupDef {
    return this.groupDefs.find((g) => g.id === group) ?? DEFAULT_GROUP_DEFS[group] ?? { id: group, name: `Grupo ${group}`, icon: '', color: '' };
  }

  // --------------------------------------------------------------- sessao --

  async connect(favorite: Favorite): Promise<void> {
    this.identity ??= await loadIdentity();
    this.favorite = favorite;
    this.audioPrefs = loadAudioPrefs(favorite.serverId);
    this.applyAudioPrefs(this.audioPrefs);
    await this.ensureAudio();

    const target: Target = {
      address: favorite.address,
      serverId: favorite.serverId,
      nickname: favorite.nickname,
      password: favorite.password,
      identity: this.identity,
    };
    this.connection.connect(target);
  }

  private applyAudioPrefs(prefs: AudioPrefs): void {
    this.mic = { ...prefs.mic };
    this.outputVolume = prefs.outputVolume;
    this.soundsEnabled = prefs.soundsEnabled;
    this.preamp = prefs.preamp;
    this.microphone.reconfigure(this.mic);
    if (this.mixer) this.mixer.volume = this.outputVolume;
    if (this.sounds) this.sounds.enabled = this.soundsEnabled;
  }

  disconnect(): void {
    this.connection.close();
  }

  private reset(): void {
    this.channels.clear();
    this.clients.clear();
    this.dmTabs.clear();
    this.activeDmTab = null;
    this.selfId = 0;
    this.myGroup = Group.Guest;
    this.groupDefs = [...DEFAULT_GROUP_DEFS];
    this.suspend();
  }

  /** Solta os recursos de audio mantendo o estado visivel do servidor. */
  private suspend(): void {
    this.mixer?.clear();
    void this.microphone.stop();
  }

  // ---------------------------------------------------------------- audio --

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
    this.sounds ??= new Sounds(this.ctx);
    this.sounds.enabled = this.soundsEnabled;
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
    this.saveAudioPrefs();
    this.onChange();
  }

  setOutputVolume(v: number): void {
    this.outputVolume = v;
    if (this.mixer && !(this.flags & ClientFlags.MutedSpeakers)) this.mixer.volume = v;
    this.saveAudioPrefs();
    this.onChange();
  }

  /** Atualiza o volume do mixer sem disparar re-render. Para sliders em tempo real. */
  setOutputVolumeDirect(v: number): void {
    this.outputVolume = v;
    if (this.mixer && !(this.flags & ClientFlags.MutedSpeakers)) this.mixer.volume = v;
  }

  setSoundsEnabled(on: boolean): void {
    this.soundsEnabled = on;
    if (this.sounds) this.sounds.enabled = on;
    this.saveAudioPrefs();
    this.onChange();
  }

  setPreamp(v: number): void {
    this.preamp = v;
    this.saveAudioPrefs();
    this.onChange();
  }

  setNotificationsEnabled(on: boolean): void {
    this.notificationsEnabled = on;
    this.onChange();
  }

  private saveAudioPrefs(): void {
    if (!this.favorite) return;
    const prefs: AudioPrefs = {
      mic: this.mic,
      outputVolume: this.outputVolume,
      soundsEnabled: this.soundsEnabled,
      preamp: this.preamp,
    };
    saveAudioPrefs(this.favorite.serverId, prefs);
  }

  private play(name: SoundName): void {
    this.sounds?.play(name);
  }

  // ------------------------------------------------- audio por usuario --

  private prefsOf(client: ClientInfo): PeerPrefs {
    const key = client.fingerprint || `id:${client.id}`;
    return this.peers.get(key) ?? { volume: 1, muted: false };
  }

  userVolume(client: ClientInfo): number {
    return this.prefsOf(client).volume;
  }

  isUserMuted(client: ClientInfo): boolean {
    return this.prefsOf(client).muted;
  }

  setUserVolume(client: ClientInfo, volume: number): void {
    const prefs = { ...this.prefsOf(client), volume };
    this.savePrefs(client, prefs);
    this.mixer?.setVolume(client.id, volume);
    this.onChange();
  }

  toggleUserMute(client: ClientInfo): void {
    const prefs = { ...this.prefsOf(client), muted: !this.isUserMuted(client) };
    this.savePrefs(client, prefs);
    this.mixer?.setMuted(client.id, prefs.muted);
    this.onChange();
  }

  private savePrefs(client: ClientInfo, prefs: PeerPrefs): void {
    const key = client.fingerprint || `id:${client.id}`;
    if (prefs.volume === 1 && !prefs.muted) this.peers.delete(key);
    else this.peers.set(key, prefs);
    savePeerPrefs(this.peers);
  }

  /** Reaplica no mixer o que ja estava escolhido para quem acabou de entrar. */
  private applyPeerPrefs(client: ClientInfo): void {
    const prefs = this.prefsOf(client);
    if (prefs.volume !== 1) this.mixer?.setVolume(client.id, prefs.volume);
    if (prefs.muted) this.mixer?.setMuted(client.id, true);
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

  editChannel(channelId: number, name: string, topic: string, maxClients: number): void {
    this.connection.send({ t: Op.EditChannel, channelId, name, topic, maxClients });
  }

  botCommand(command: string, ...args: string[]): void {
    this.connection.send({ t: Op.BotCommand, command, args });
  }

  say(text: string, scope?: ChatScope, targetId?: number): void {
    const body = text.trim();
    if (!body) return;
    if (body.startsWith('/')) {
      const parts = body.slice(1).split(/\s+/);
      const command = parts[0] ?? '';
      const args = parts.slice(1);
      this.connection.send({ t: Op.BotCommand, command, args });
      return;
    }
    const s = scope ?? (this.activeDmTab !== null ? ChatScope.Private : ChatScope.Channel);
    const t = targetId ?? (this.activeDmTab !== null ? this.activeDmTab : 0);
    this.connection.send({ t: Op.ChatSend, scope: s, targetId: t, text: body });
  }

  kick(clientId: number, reason: string): void {
    this.connection.send({ t: Op.KickClient, clientId, reason });
  }

  ban(clientId: number, minutes: number, reason: string): void {
    this.connection.send({ t: Op.BanClient, clientId, minutes, reason });
  }

  moveUser(clientId: number, channelId: number): void {
    this.connection.send({ t: Op.MoveClient, clientId, channelId });
  }

  setGroup(clientId: number, group: Group): void {
    this.connection.send({ t: Op.SetClientGroup, clientId, group });
  }

  setGroupDef(group: Group, name: string, icon: string, color: string): void {
    this.connection.send({ t: Op.SetGroupDef, group, name, icon, color });
  }

  toggleMic(): void {
    this.setFlags(this.flags ^ ClientFlags.MutedMic);
  }

  toggleSpeakers(): void {
    const next =
      this.flags & ClientFlags.MutedSpeakers
        ? this.flags & ~(ClientFlags.MutedSpeakers | ClientFlags.MutedMic)
        : this.flags | ClientFlags.MutedSpeakers | ClientFlags.MutedMic;
    this.setFlags(next);
  }

  toggleAway(): void {
    this.setFlags(this.flags ^ ClientFlags.Away);
  }

  private setFlags(flags: number): void {
    this.connection.send({ t: Op.SetSelfState, flags });
    if (this.mixer) this.mixer.volume = flags & ClientFlags.MutedSpeakers ? 0 : this.outputVolume;
    const me = this.self;
    if (me) me.flags = flags;
    this.syncMicMute();
    this.onChange();
  }

  private syncMicMute(): void {
    const me = this.self;
    const userMuted = (me?.flags ?? 0) & ClientFlags.MutedMic;
    const silenced = me ? this.isVoiceSilenced(me) : false;
    this.microphone.muted = !!(userMuted || silenced);
  }

  setPtt(down: boolean): void {
    this.microphone.pttDown = down;
  }

  setNickname(nickname: string): void {
    this.connection.send({ t: Op.SetSelfState, flags: this.flags, nickname });
  }

  clearUnread(): void {
    if (this.unread === 0) return;
    this.unread = 0;
    this.onChange();
  }

  // --------------------------------------------------------- DM / privado --

  openDm(clientId: number): void {
    if (clientId === this.selfId) return;
    if (!this.dmTabs.has(clientId)) {
      const c = this.clients.get(clientId);
      this.dmTabs.set(clientId, { clientId, name: c?.nickname ?? `#${clientId}`, unread: 0 });
    }
    this.activeDmTab = clientId;
    this.onChange();
  }

  closeDm(clientId: number): void {
    this.dmTabs.delete(clientId);
    if (this.activeDmTab === clientId) this.activeDmTab = null;
    this.onChange();
  }

  channelMessages(): ChatLine[] {
    return this.chat.filter((m) => m.scope !== ChatScope.Private);
  }

  dmMessages(otherId: number): ChatLine[] {
    return this.chat.filter((m) =>
      m.scope === ChatScope.Private &&
      ((m.senderId === otherId && m.targetId === this.selfId) ||
       (m.senderId === this.selfId && m.targetId === otherId) ||
       (m.senderId === 0 && m.targetId === otherId)),
    );
  }

  // ----------------------------------------------------------- recebidos --

  private apply(m: ServerMessage): void {
    switch (m.t) {
      case Op.Welcome:
        this.selfId = m.clientId;
        this.serverId = m.serverId;
        this.serverName = m.serverName;
        this.motd = m.motd;
        this.myGroup = m.group;
        if (this.favorite) touchFavorite(this.favorite.id);
        this.play('connected');
        break;

      case Op.Snapshot:
        this.channels.clear();
        this.clients.clear();
        for (const c of m.channels) this.channels.set(c.id, c);
        for (const c of m.clients) {
          this.clients.set(c.id, c);
          this.applyPeerPrefs(c);
        }
        void this.startMic();
        this.syncMicMute();
        break;

      case Op.ChannelAdd:
      case Op.ChannelUpdate:
        this.channels.set(m.channel.id, m.channel);
        this.syncMicMute();
        break;

      case Op.ChannelRemove:
        this.channels.delete(m.channelId);
        break;

      case Op.ClientAdd: {
        // Serve tambem de atualizacao: o servidor reenvia ClientAdd quando o
        // grupo de alguem muda.
        const isNew = !this.clients.has(m.client.id);
        this.clients.set(m.client.id, m.client);
        this.applyPeerPrefs(m.client);
        if (m.client.id === this.selfId) {
          this.myGroup = m.client.group;
          this.syncMicMute();
        }
        if (isNew && this.link === 'online') this.play('join');
        break;
      }

      case Op.ClientRemove:
        this.clients.delete(m.clientId);
        this.mixer?.remove(m.clientId);
        this.play('leave');
        break;

      case Op.ClientMove: {
        const c = this.clients.get(m.clientId);
        if (c) c.channelId = m.channelId;
        if (m.clientId === this.selfId) this.syncMicMute();
        break;
      }

      case Op.ClientState: {
        const c = this.clients.get(m.clientId);
        if (c) c.flags = m.flags;
        if (m.clientId === this.selfId) this.syncMicMute();
        break;
      }

      case Op.ChatDeliver: {
        const line: ChatLine = {
          scope: m.scope,
          senderId: m.senderId,
          targetId: m.targetId,
          senderName: m.senderName,
          text: m.text,
          stamp: m.stamp,
        };
        this.chat.push(line);
        if (this.chat.length > MAX_CHAT_LINES) this.chat.shift();
        const isPoke = m.senderId === 0 && m.text.includes('cutucou');
        if (isPoke) {
          this.play('poke');
          const pokeMatch = m.text.match(/👉\s*(.+?)\s+(?:te cutucou|cutucou todo[^:]*?)(?::\s*(.+))?$/);
          const from = pokeMatch?.[1] ?? 'Alguém';
          const customMsg = pokeMatch?.[2] ?? '';
          this.onPoke?.(from, customMsg);
          if (this.notificationsEnabled) notifications.poke(from);
        } else if (m.senderId !== this.selfId) {
          if (m.scope === ChatScope.Private) {
            const otherId = m.senderId;
            if (!this.dmTabs.has(otherId)) {
              this.dmTabs.set(otherId, { clientId: otherId, name: m.senderName, unread: 0 });
            }
            if (this.activeDmTab !== otherId) {
              const tab = this.dmTabs.get(otherId)!;
              tab.unread++;
            }
            this.play('message');
            if (this.notificationsEnabled) notifications.privateMessage(m.senderName, m.text);
          } else {
            this.unread++;
            this.play('message');
            if (this.notificationsEnabled && m.scope === ChatScope.Channel) {
              const myNick = this.self?.nickname?.toLowerCase();
              if (myNick && m.text.toLowerCase().includes(`@${myNick}`)) {
                notifications.mention(m.senderName, this.channels.get(m.targetId)?.name || 'canal', m.text);
              }
            }
          }
        }
        break;
      }

      case Op.BotCommandResult:
        this.chat.push({
          scope: ChatScope.Server,
          senderId: 0,
          targetId: 0,
          senderName: 'bot',
          text: m.message,
          stamp: Date.now(),
        });
        if (this.chat.length > MAX_CHAT_LINES) this.chat.shift();
        if (this.onBotResult) {
          const cb = this.onBotResult;
          this.onBotResult = null;
          cb(m.message);
        }
        break;

      case Op.GroupDefs:
        this.groupDefs = m.groups;
        break;

      case Op.Failure:
        // Notificacao para kick/ban
        if (this.notificationsEnabled) {
          if (m.code === FailureCode.Banned) {
            notifications.moderation('ban', m.message);
          } else if (m.code === FailureCode.NotPermitted && m.message.toLowerCase().includes('expulso')) {
            notifications.moderation('kick', m.message);
          }
        }
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

function loadPeerPrefs(): Map<string, PeerPrefs> {
  try {
    const raw = JSON.parse(localStorage.getItem(VOLUME_KEY) ?? '{}') as Record<string, PeerPrefs>;
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
}

function savePeerPrefs(peers: Map<string, PeerPrefs>): void {
  try {
    localStorage.setItem(VOLUME_KEY, JSON.stringify(Object.fromEntries(peers)));
  } catch {
    // modo privado
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
