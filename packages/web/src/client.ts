/**
 * Cliente Vox: junta conexao, identidade, microfone e reproducao, e mantem uma
 * copia do estado do servidor. A interface le esse estado e chama os metodos
 * daqui - nao conhece protocolo nem Web Audio.
 */

import { BotControlAction, ChannelFlags, ChatScope, ClientFlags, DEFAULT_GROUP_DEFS, DEFAULT_PERMISSIONS, DEFAULT_PRESET_ID, FailureCode, Group, NO_CHANNEL, Op, PermissionAction, findPreset, parsePreset } from '@vox/protocol';
import type { BotStateInfo, ChannelInfo, ClientInfo, GroupDef, PermissionEntry, PlayerInfo, RespClaimInfo, ServerMessage, ServerPreset, UserProfile } from '@vox/protocol';
import { Connection, type LinkState, type Target, type VoiceTransport } from './net/connection.js';
import { LiveKitVoice, type LiveKitVoiceState } from './net/livekit-voice.js';
import { DEFAULT_MIC, Microphone, type MicSettings } from './audio/microphone.js';
import { VoiceMixer, type VoicePlaybackHealth, type VoiceSenderStats } from './audio/mixer.js';
import { VoiceRecorder, type RecordingTelemetry, type VoiceRecordingResult } from './audio/recording.js';
import { DEFAULT_SOUND_EVENTS, Sounds, type SoundName, type SoundPackId } from './audio/sounds.js';
import { loadIdentity, type Identity } from './identity.js';
import { loadAudioPrefs, saveAudioPrefs, type AudioPrefs } from './audio-prefs.js';
import { touchFavorite, type Favorite } from './favorites.js';
import { notifications } from './notifications.js';
import { ScreenShare } from './screen-share.js';
import { emptyProfile, loadLocalProfile, normalizeProfile, saveLocalProfile } from './profile.js';

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
/** Cadencia da medicao de voz: estavel o bastante, barata o bastante. */
const VOICE_SAMPLE_MS = 2_000;
/** ~5 minutos de historico — o suficiente para comparar antes e depois. */
const VOICE_HISTORY_SAMPLES = 150;
/** Queda mais curta que isto nao chega a soltar o microfone. */
const MIC_RELEASE_DELAY_MS = 1_500;

/** Um ponto da serie de qualidade da voz. */
export interface VoiceSample {
  at: number;
  transport: VoiceTransport;
  rttMs: number;
  voiceRttMs: number;
  /** Pior jitter de recepcao na janela, em ms. */
  jitterMs: number;
  /** Pior perda de recepcao na janela, em %. */
  lossPct: number;
}

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
  /** fingerprint -> perfil visual; avatares chegam em frames separados. */
  readonly profiles = new Map<string, UserProfile>();
  readonly claims = new Map<number, RespClaimInfo>();
  botState: BotStateInfo | null = null;
  /** fingerprint -> info do char Tibia (vocation/level/online), via bot Rubinot. */
  readonly playerInfos = new Map<string, PlayerInfo>();
  /** Overrides atuais das permissoes. Falta = default. */
  readonly permissions = new Map<PermissionAction, Group>();
  /**
   * Preset ativo do servidor. A arvore de canais do template, o catalogo de
   * respawn e a disponibilidade do bot saem daqui — nao de constantes fixas,
   * senao o cliente ofereceria hunt do Rubinot num servidor de 7.4.
   */
  preset: ServerPreset = findPreset(DEFAULT_PRESET_ID)!;
  /** peerId -> maior stamp da minha DM outgoing que este peer confirmou ler. */
  readonly dmReadStamps = new Map<number, number>();
  /** peerId -> maior stamp por qual ja mandei ChatRead, evita reenviar. */
  private readonly dmReadSent = new Map<number, number>();
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
  maxClients = 128;
  serverId = 0;
  presetId = 'rubinot';
  selfId = 0;
  myGroup: Group = Group.Guest;

  identity: Identity | null = null;
  favorite: Favorite | null = null;

  groupDefs: GroupDef[] = [...DEFAULT_GROUP_DEFS];
  mic: MicSettings = { ...DEFAULT_MIC };
  outputVolume = 1;
  soundsEnabled = true;
  soundPack: SoundPackId = 'radio';
  soundVolume = 0.7;
  soundEvents: Record<SoundName, boolean> = { ...DEFAULT_SOUND_EVENTS };
  preamp = 1;
  notificationsEnabled = true;
  onPoke: ((from: string, text: string) => void) | null = null;
  onBotResult: ((message: string) => void) | null = null;
  /** Chamado quando o painel ou outro Dono altera a configuração do bot. */
  onBotStateChange: (() => void) | null = null;

  private audioPrefs: AudioPrefs | null = null;
  private connectGeneration = 0;
  private profileSentForConnection = false;
  private profileReceivedForConnection = false;
  private adaptiveBitrateChangedAt = 0;
  private liveKitFallbackAttemptAt = 0;
  private liveKitFallbackStarting = false;

  private ctx: AudioContext | null = null;
  private workletsReady: Promise<void> | null = null;
  private mixer: VoiceMixer | null = null;
  /** Fecha a janela de medicao de jitter/perda em cadencia fixa. */
  private voiceSampler: ReturnType<typeof setInterval> | null = null;
  /** Espera antes de soltar o microfone numa queda; ver suspend(). */
  private micRelease: ReturnType<typeof setTimeout> | null = null;
  private senderStats: VoiceSenderStats[] = [];
  private readonly history: VoiceSample[] = [];
  private recorder: VoiceRecorder | null = null;
  private sounds: Sounds | null = null;
  private readonly peers = new Map<string, PeerPrefs>();

  /** Última gravação finalizada, disponível para ouvir/baixar nesta sessão. */
  lastRecording: VoiceRecordingResult | null = null;

  readonly connection: Connection;
  private pendingProfile: { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; expected: UserProfile } | null = null;
  readonly microphone: Microphone;
  readonly liveKitVoice: LiveKitVoice;
  readonly screen: ScreenShare;

  constructor(
    private readonly onChange: () => void,
    private readonly onLiveConnectionStatus: () => void = () => {},
  ) {
    this.peers = loadPeerPrefs();
    this.liveKitVoice = new LiveKitVoice({
      onState: (state, detail) => this.handleLiveKitVoiceState(state, detail),
      onTalkingChange: () => this.onLiveConnectionStatus(),
    });
    this.connection = new Connection({
      onState: (link, detail) => {
        const wasOnline = this.link === 'online';
        this.link = link;
        if (link !== 'online') this.finishProfileSave(new Error('Você está offline. Reconecte para publicar o perfil.'));
        this.detail = detail;
        if (link === 'offline') this.reset();
        // Reconectando: cala o audio mas deixa a arvore na tela, senao a
        // interface pisca vazia a cada oscilacao de rede.
        if (link === 'connecting') this.suspend();
        if (link === 'online') this.cancelMicRelease();
        if (wasOnline && link !== 'online') this.play('lost');
        this.onChange();
      },
      onMessage: (m) => this.apply(m),
      onVoice: (p) => this.mixer?.push(p),
      onVoiceFallbackNeeded: (reason) => void this.startLiveKitFallback(reason),
      // Métricas de voz mudam continuamente. A tela atualiza somente o
      // indicador no header; reconstruir o shell aqui faria o scroll piscar.
      onVoiceTransport: () => this.onLiveConnectionStatus(),
      onVoiceStats: () => {
        this.adaptVoiceBitrate();
        this.onLiveConnectionStatus();
      },
    });
    this.microphone = new Microphone((frame) => this.connection.sendVoice(frame, this.liveKitVoice.active));
    this.microphone.onTransmissionChange = (active) => this.liveKitVoice.setTransmissionEnabled(active);
    this.screen = new ScreenShare(
      {
        selfId: () => this.selfId,
        selfChannelId: () => this.self?.channelId ?? 0,
        membersOf: (channelId) => this.membersOf(channelId),
        requestLiveKitToken: (channelId) => this.connection.requestLiveKitToken(channelId),
      },
      (m) => this.connection.send(m),
      this.onChange,
    );
  }

  // ------------------------------------------------------------ consultas --

  get self(): ClientInfo | undefined {
    return this.clients.get(this.selfId);
  }

  profileFor(client: ClientInfo | undefined): UserProfile {
    if (!client?.fingerprint) return emptyProfile();
    return this.profiles.get(client.fingerprint) ?? emptyProfile(client.fingerprint);
  }

  get flags(): number {
    return this.self?.flags ?? 0;
  }

  get micLevel(): number {
    return this.microphone.level;
  }

  get liveKitVoiceActive(): boolean {
    return this.liveKitVoice.active;
  }

  get liveKitVoiceState(): LiveKitVoiceState {
    return this.liveKitVoice.state;
  }

  isVoiceSilenced(c: ClientInfo): boolean {
    const ch = this.channels.get(c.channelId);
    if (!ch) return false;
    if (ch.flags & ChannelFlags.VoiceDisabled) return true;
    if (!(ch.flags & ChannelFlags.Moderated)) return false;
    return c.group < Group.Moderator && !(c.flags & ClientFlags.HasVoice);
  }

  isTalking(clientId: number): boolean {
    if (clientId === this.selfId) {
      if (!this.microphone.transmitting) return false;
      const me = this.self;
      if (me && this.isVoiceSilenced(me)) return false;
      return true;
    }
    return (this.mixer?.isTalking(clientId) ?? false) || this.liveKitVoice.isTalking(clientId);
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

  /** Pode reorganizar este canal na arvore? Canais padrao sao fixos. */
  canMoveChannel(channel: ChannelInfo): boolean {
    if (channel.flags & ChannelFlags.Default) return false;
    return this.myGroup >= this.permissionFor(PermissionAction.MoveChannel);
  }

  groupDef(group: Group): GroupDef {
    return this.groupDefs.find((g) => g.id === group) ?? DEFAULT_GROUP_DEFS[group] ?? { id: group, name: `Grupo ${group}`, icon: '', color: '' };
  }

  // --------------------------------------------------------------- sessao --

  async connect(favorite: Favorite): Promise<void> {
    const generation = ++this.connectGeneration;
    this.identity ??= await loadIdentity();
    if (generation !== this.connectGeneration) return;
    this.favorite = favorite;
    this.audioPrefs = loadAudioPrefs(favorite.serverId);
    this.applyAudioPrefs(this.audioPrefs);

    const target: Target = {
      address: favorite.address,
      serverId: favorite.serverId,
      nickname: favorite.nickname,
      password: favorite.password,
      identity: this.identity,
    };
    // A rede nao deve ficar refem da permissao do microfone ou do AudioWorklet.
    // O usuario pode entrar sem audio e resolver isso depois nas preferencias.
    void this.ensureAudio().then(() => {
      if (this.link === 'online') void this.startMic();
    }).catch((err) => {
      this.warn(`audio indisponivel: ${describeError(err)}`);
    });
    if (generation !== this.connectGeneration) return;
    this.connection.connect(target);
  }

  private applyAudioPrefs(prefs: AudioPrefs): void {
    this.mic = { ...prefs.mic };
    this.outputVolume = prefs.outputVolume;
    this.soundsEnabled = prefs.soundsEnabled;
    this.soundPack = prefs.soundPack;
    this.soundVolume = prefs.soundVolume;
    this.soundEvents = { ...DEFAULT_SOUND_EVENTS, ...prefs.soundEvents };
    this.preamp = prefs.preamp;
    this.outputDeviceId = prefs.outputDeviceId ?? '';
    this.microphone.reconfigure(this.mic);
    this.liveKitVoice.setOutputVolume(this.outputVolume);
    void this.liveKitVoice.setOutputDevice(this.outputDeviceId);
    if (this.mixer) {
      this.mixer.volume = this.outputVolume;
      this.mixer.preamp = this.preamp;
    }
    this.applySoundPrefs();
  }

  disconnect(): void {
    this.connectGeneration++;
    this.stopLiveKitFallback();
    this.connection.close();
  }

  private reset(): void {
    // Não deixa uma gravação atravessar desconexões ou misturar duas sessões.
    if (this.isVoiceRecording) void this.stopVoiceRecording();
    this.channels.clear();
    this.clients.clear();
    this.profiles.clear();
    this.claims.clear();
    this.playerInfos.clear();
    this.permissions.clear();
    this.preset = findPreset(DEFAULT_PRESET_ID)!;
    this.presetId = DEFAULT_PRESET_ID;
    this.maxClients = 128;
    this.dmTabs.clear();
    this.dmReadStamps.clear();
    this.dmReadSent.clear();
    this.activeDmTab = null;
    this.selfId = 0;
    this.myGroup = Group.Guest;
    this.groupDefs = [...DEFAULT_GROUP_DEFS];
    this.botState = null;
    this.profileSentForConnection = false;
    this.profileReceivedForConnection = false;
    this.screen.close();
    this.liveKitVoice.disconnect();
    // Offline de verdade: nao ha reconexao a caminho para justificar segurar o
    // dispositivo, entao o microfone sai na hora.
    this.cancelMicRelease();
    this.mixer?.clear();
    void this.microphone.stop();
  }

  /**
   * Solta os recursos de audio mantendo o estado visivel do servidor.
   *
   * O mixer some na hora: os ids de cliente sao por sessao, entao os
   * decodificadores antigos nao servem para ninguem depois de reconectar.
   *
   * O microfone e o contrario — parar e reabrir pisca o indicador do
   * navegador, solta o dispositivo e pode engasgar na volta. Numa queda de
   * meio segundo isso e barulho puro, entao ele so e liberado se a ausencia
   * durar. Enquanto isso, os quadros capturados sao descartados no envio,
   * que ja ignora socket fechado.
   */
  private suspend(): void {
    this.stopLiveKitFallback();
    this.mixer?.clear();
    if (this.micRelease !== null) return;
    this.micRelease = setTimeout(() => {
      this.micRelease = null;
      void this.microphone.stop();
    }, MIC_RELEASE_DELAY_MS);
  }

  private cancelMicRelease(): void {
    if (this.micRelease === null) return;
    clearTimeout(this.micRelease);
    this.micRelease = null;
  }

  // -------------------------------------------------------- qualidade --

  /**
   * Fecha a janela de medicao a cada VOICE_SAMPLE_MS e guarda uma amostra.
   * Duas coisas dependem disso: a leitura ao vivo no header e a serie que o
   * relatorio de gravacao carrega — sem historico nao da para dizer se uma
   * mudanca melhorou alguma coisa.
   */
  private startVoiceSampler(): void {
    if (this.voiceSampler) return;
    this.voiceSampler = setInterval(() => {
      const mixer = this.mixer;
      // Offline nao ha o que medir, e uma amostra de zeros sujaria a serie que
      // existe justamente para comparar sessoes.
      if (!mixer || this.link !== 'online') return;
      this.senderStats = mixer.sample();
      this.connection.noteReception(mixer.health.jitterMs, mixer.health.lossPct);
      this.history.push({
        at: Date.now(),
        transport: this.connection.voiceTransport,
        rttMs: this.connection.rtt,
        voiceRttMs: this.connection.voiceRtt,
        jitterMs: mixer.health.jitterMs,
        lossPct: mixer.health.lossPct,
      });
      if (this.history.length > VOICE_HISTORY_SAMPLES) this.history.shift();
      this.onLiveConnectionStatus();
    }, VOICE_SAMPLE_MS);
    this.voiceSampler.unref?.();
  }

  /**
   * Mantem a preferencia escolhida como teto, mas reduz o bitrate quando a
   * rede entra em estado instavel. Assim a voz perde menos pacotes antes de
   * recorrer ao descarte de backpressure; quando a janela volta a ficar boa,
   * o valor escolhido pelo usuario e restaurado.
   */
  private adaptVoiceBitrate(): void {
    if (this.link !== 'online') return;
    const quality = this.connection.voiceQuality;
    if (quality === 'unknown' || quality === 'measuring') return;
    const preferred = this.mic.bitrate;
    const target = quality === 'unstable'
      ? Math.min(preferred, 24_000)
      : quality === 'good'
        ? Math.min(preferred, 32_000)
        : preferred;
    if (target === this.microphone.settings.bitrate) return;
    const now = Date.now();
    if (now - this.adaptiveBitrateChangedAt < 4_000) return;
    this.adaptiveBitrateChangedAt = now;
    this.microphone.reconfigure({ bitrate: target });
  }

  /** Qualidade de recepcao por remetente, para a interface apontar quem esta ruim. */
  get voiceSenders(): readonly VoiceSenderStats[] {
    return this.senderStats;
  }

  /** Serie recente de qualidade, do mais antigo para o mais novo. */
  get voiceHistory(): readonly VoiceSample[] {
    return this.history;
  }

  // ---------------------------------------------------------------- audio --

  /**
   * O AudioContext so pode nascer dentro de um gesto do usuario, por isso a
   * inicializacao mora no clique de conectar e nao no carregamento da pagina.
   */
  private async ensureAudio(): Promise<void> {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
      if (this.outputDeviceId && 'setSinkId' in this.ctx) {
        (this.ctx as unknown as { setSinkId(id: string): Promise<void> }).setSinkId(this.outputDeviceId).catch(() => {});
      }
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
      this.mixer.preamp = this.preamp;
      this.startVoiceSampler();
    }
    this.sounds ??= new Sounds(this.ctx);
    this.applySoundPrefs();
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

  /** Ativa a sala LiveKit somente depois de duas janelas ruins no caminho Vox. */
  private async startLiveKitFallback(reason: string): Promise<void> {
    if (
      this.liveKitFallbackStarting
      || this.liveKitVoice.active
      || this.link !== 'online'
      || !this.self?.channelId
      || !this.microphone.mediaStreamTrack
    ) return;
    const now = Date.now();
    if (now < this.liveKitFallbackAttemptAt) return;

    const generation = this.connectGeneration;
    const channelId = this.self.channelId;
    const source = this.microphone.mediaStreamTrack;
    if (!source) return;
    this.liveKitFallbackStarting = true;
    this.onLiveConnectionStatus();
    try {
      const credentials = await this.connection.requestLiveKitVoiceToken(channelId);
      if (generation !== this.connectGeneration || this.link !== 'online' || this.self?.channelId !== channelId) return;
      await this.liveKitVoice.connect(credentials, source, this.microphone.muted, this.microphone.transmitting);
      if (generation !== this.connectGeneration || this.link !== 'online' || this.self?.channelId !== channelId) {
        this.stopLiveKitFallback();
      }
    } catch (error) {
      this.liveKitFallbackAttemptAt = Date.now() + 30_000;
      this.warn(`fallback LiveKit indisponível: ${describeError(error)}`);
    } finally {
      this.liveKitFallbackStarting = false;
      this.onLiveConnectionStatus();
    }
  }

  private handleLiveKitVoiceState(state: LiveKitVoiceState, detail: string): void {
    if (state === 'connected') {
      this.setLiveKitVoiceFlag(true);
    } else if (state === 'failed' || state === 'idle') {
      this.liveKitFallbackAttemptAt = Date.now() + 30_000;
      this.setLiveKitVoiceFlag(false);
    }
    if (state === 'failed' && !this.liveKitFallbackStarting) this.warn(detail);
    this.onLiveConnectionStatus();
    this.onChange();
  }

  private stopLiveKitFallback(): void {
    const wasActive = this.liveKitVoice.active || Boolean(this.flags & ClientFlags.LiveKitVoice);
    this.liveKitVoice.disconnect();
    if (wasActive) this.setLiveKitVoiceFlag(false);
  }

  private setLiveKitVoiceFlag(enabled: boolean): void {
    const me = this.self;
    const current = Boolean((me?.flags ?? 0) & ClientFlags.LiveKitVoice);
    if (current === enabled) return;
    const next = enabled ? this.flags | ClientFlags.LiveKitVoice : this.flags & ~ClientFlags.LiveKitVoice;
    if (me) me.flags = next;
    this.connection.send({ t: Op.SetSelfState, flags: next });
    this.syncMicMute();
    this.onLiveConnectionStatus();
  }

  async applyMicSettings(patch: Partial<MicSettings>): Promise<void> {
    const restart = patch.deviceId !== undefined && patch.deviceId !== this.mic.deviceId;
    if (restart && this.liveKitVoice.active) this.stopLiveKitFallback();
    this.mic = { ...this.mic, ...patch };
    this.microphone.reconfigure(patch);
    if (restart && this.link === 'online') await this.startMic();
    this.saveAudioPrefs();
    this.onChange();
  }

  get isVoiceRecording(): boolean {
    return this.recorder?.recording ?? false;
  }

  get recordingElapsedMs(): number {
    return this.recorder?.elapsedMs ?? 0;
  }

  async startVoiceRecording(): Promise<boolean> {
    try {
      await this.ensureAudio();
      if (!this.ctx || !this.mixer || !VoiceRecorder.supported) return false;
      this.recorder ??= new VoiceRecorder(this.ctx);
      const telemetry = this.recordingTelemetry();
      this.mixer.setRecordTap(this.recorder.input);
      this.microphone.setRecordTap(this.recorder.input);
      this.recorder.start(telemetry);
      this.onChange();
      return true;
    } catch (err) {
      this.mixer?.setRecordTap(null);
      this.microphone.setRecordTap(null);
      this.warn(`gravação indisponível: ${describeError(err)}`);
      return false;
    }
  }

  async stopVoiceRecording(): Promise<VoiceRecordingResult | null> {
    const recorder = this.recorder;
    if (!recorder?.recording) return null;

    this.mixer?.setRecordTap(null);
    this.microphone.setRecordTap(null);
    let result: VoiceRecordingResult | null;
    try {
      result = await recorder.stop(this.recordingTelemetry());
    } catch (err) {
      this.warn(`gravação não finalizada: ${describeError(err)}`);
      return null;
    }
    if (!result) return null;

    if (this.lastRecording) {
      URL.revokeObjectURL(this.lastRecording.audioUrl);
      URL.revokeObjectURL(this.lastRecording.reportUrl);
    }
    this.lastRecording = result;
    downloadBlob(result.audioBlob, recordingFilename(result.report.startedAt, audioExtension(result.report.mimeType)));
    downloadBlob(result.reportBlob, recordingFilename(result.report.startedAt, 'json'));
    this.onChange();
    return result;
  }

  private recordingTelemetry(): RecordingTelemetry {
    const health = this.microphone.health;
    const playback: VoicePlaybackHealth = this.mixer?.health ?? {
      receivedPackets: 0,
      latePackets: 0,
      reorderedPackets: 0,
      skippedPackets: 0,
      jitterMs: 0,
      lossPct: 0,
    };
    return {
      transport: this.connection.voiceTransport,
      rttMs: this.connection.rtt,
      voiceRttMs: this.connection.voiceRtt,
      voiceRegion: this.connection.voiceRegion,
      voiceQuality: this.connection.voiceQuality,
      droppedVoice: this.connection.droppedVoice,
      mic: {
        ...this.mic,
        bitrate: this.microphone.settings.bitrate,
        health: { ...health },
      },
      playback: { ...playback },
      senders: this.senderStats.map((sender) => ({ ...sender })),
      history: this.history.map((sample) => ({ ...sample })),
    };
  }

  /** Calibra o limiar usando o ruido ambiente do microfone atual. */
  async calibrateMicThreshold(): Promise<number | null> {
    const threshold = await this.microphone.calibrateThreshold();
    if (threshold === null) return null;
    await this.applyMicSettings({ threshold });
    return threshold;
  }

  setOutputVolume(v: number): void {
    this.outputVolume = v;
    if (this.mixer && !(this.flags & ClientFlags.MutedSpeakers)) this.mixer.volume = v;
    this.liveKitVoice.setOutputVolume(v);
    this.saveAudioPrefs();
    this.onChange();
  }

  /** Atualiza o volume do mixer sem disparar re-render. Para sliders em tempo real. */
  setOutputVolumeDirect(v: number): void {
    this.outputVolume = v;
    if (this.mixer && !(this.flags & ClientFlags.MutedSpeakers)) this.mixer.volume = v;
    this.liveKitVoice.setOutputVolume(v);
  }

  outputDeviceId = '';

  async setOutputDevice(deviceId: string): Promise<void> {
    this.outputDeviceId = deviceId;
    if (this.ctx && 'setSinkId' in this.ctx) {
      await (this.ctx as unknown as { setSinkId(id: string): Promise<void> }).setSinkId(deviceId);
    }
    await this.liveKitVoice.setOutputDevice(deviceId);
    this.saveAudioPrefs();
  }

  setSoundsEnabled(on: boolean): void {
    this.soundsEnabled = on;
    if (this.sounds) this.sounds.enabled = on;
    this.saveAudioPrefs();
    this.onChange();
  }

  setSoundPack(pack: SoundPackId): void {
    this.soundPack = pack;
    if (this.sounds) this.sounds.pack = pack;
    this.saveAudioPrefs();
  }

  setSoundVolumeDirect(v: number): void {
    this.soundVolume = Math.max(0, Math.min(1, v));
    if (this.sounds) this.sounds.volume = this.soundVolume;
    this.saveAudioPrefs();
  }

  setSoundEventEnabled(name: SoundName, enabled: boolean): void {
    this.soundEvents[name] = enabled;
    this.sounds?.setEventEnabled(name, enabled);
    this.saveAudioPrefs();
  }

  previewSound(name: SoundName): void {
    if (this.sounds) {
      this.sounds.preview(name);
      return;
    }
    void this.ensureAudio().then(() => this.sounds?.preview(name)).catch(() => {});
  }

  setPreamp(v: number): void {
    this.preamp = v;
    if (this.mixer) this.mixer.preamp = v;
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
      soundPack: this.soundPack,
      soundVolume: this.soundVolume,
      soundEvents: { ...this.soundEvents },
      preamp: this.preamp,
      outputDeviceId: this.outputDeviceId,
    };
    saveAudioPrefs(this.favorite.serverId, prefs);
  }

  private play(name: SoundName): void {
    this.sounds?.play(name);
  }

  private applySoundPrefs(): void {
    if (!this.sounds) return;
    this.sounds.enabled = this.soundsEnabled;
    this.sounds.pack = this.soundPack;
    this.sounds.volume = this.soundVolume;
    for (const name of Object.keys(this.soundEvents) as SoundName[]) {
      this.sounds.setEventEnabled(name, this.soundEvents[name]);
    }
  }

  private playFlagChange(previous: number, next: number): void {
    if ((previous ^ next) & ClientFlags.MutedSpeakers) {
      this.play(next & ClientFlags.MutedSpeakers ? 'deafen' : 'undeafen');
    } else if ((previous ^ next) & ClientFlags.MutedMic) {
      this.play(next & ClientFlags.MutedMic ? 'mute' : 'unmute');
    }
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
    this.liveKitVoice.setPeerVolume(client.id, volume);
    // Nao dispara onChange: o handler do slider ja atualiza o label; um
    // re-render completo destroi o input no meio do drag, travando o cursor.
  }

  toggleUserMute(client: ClientInfo): void {
    const prefs = { ...this.prefsOf(client), muted: !this.isUserMuted(client) };
    this.savePrefs(client, prefs);
    this.mixer?.setMuted(client.id, prefs.muted);
    this.liveKitVoice.setPeerMuted(client.id, prefs.muted);
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
    if (prefs.volume !== 1) this.liveKitVoice.setPeerVolume(client.id, prefs.volume);
    if (prefs.muted) this.liveKitVoice.setPeerMuted(client.id, true);
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

  moveChannel(channelId: number, parentId: number, beforeChannelId = NO_CHANNEL): void {
    this.connection.send({ t: Op.MoveChannel, channelId, parentId, beforeChannelId });
  }

  botCommand(command: string, ...args: string[]): void {
    this.connection.send({ t: Op.BotCommand, command, args });
  }

  claimResp(respawn: string, note: string, durationMin: number): void {
    this.connection.send({ t: Op.ClaimResp, respawn, note, durationMin });
  }

  releaseResp(claimId: number): void {
    this.connection.send({ t: Op.ReleaseResp, claimId });
  }

  joinRespQueue(claimId: number): void {
    this.connection.send({ t: Op.JoinRespQueue, claimId });
  }

  leaveRespQueue(claimId: number): void {
    this.connection.send({ t: Op.LeaveRespQueue, claimId });
  }

  getBotState(): void {
    this.connection.send({ t: Op.GetBotState });
  }

  updateBotConfig(
    cfg: Omit<BotStateInfo, 'hunted' | 'friends' | 'friendGuilds' | 'enemyGuilds' | 'running' | 'starting' | 'error'>,
  ): void {
    this.connection.send({
      t: Op.UpdateBotConfig,
      world: cfg.world,
      guildName: cfg.guildName,
      channelName: cfg.channelName,
      intervalMs: cfg.intervalMs,
      enabled: cfg.enabled,
      globalDeaths: cfg.globalDeaths,
      globalKills: cfg.globalKills,
      globalLevelMin: cfg.globalLevelMin,
      summarizePresence: cfg.summarizePresence,
      presenceSummaryMs: cfg.presenceSummaryMs,
      alertEnemyDeath: cfg.alertEnemyDeath,
      alertFriendDeath: cfg.alertFriendDeath,
      alertFriendLevelUp: cfg.alertFriendLevelUp,
      alertEnemyLevelUp: cfg.alertEnemyLevelUp,
      alertEnemyOnline: cfg.alertEnemyOnline,
      alertEnemyOffline: cfg.alertEnemyOffline,
    });
  }

  botControl(action: BotControlAction, name = ''): void {
    this.connection.send({ t: Op.BotControl, action, name });
  }

  /** Marca as DMs recebidas deste peer como lidas ate `upToStamp`. */
  markDmRead(peerId: number): void {
    const msgs = this.dmMessages(peerId);
    // Ultima mensagem recebida (que nao seja minha).
    let last = 0;
    for (const m of msgs) {
      if (m.senderId === peerId && m.stamp > last) last = m.stamp;
    }
    if (last === 0) return;
    // Nao reenviar o mesmo ack: o peer responde com ChatReadDeliver, que
    // dispara re-render. Sem essa guarda, ficaria em loop com a re-render
    // mandando outro ChatRead identico.
    const already = this.dmReadSent.get(peerId) ?? 0;
    if (last <= already) return;
    this.dmReadSent.set(peerId, last);
    this.connection.send({ t: Op.ChatRead, targetId: peerId, upToStamp: last });
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

  editServer(name: string, motd: string, maxClients: number): void {
    this.connection.send({ t: Op.EditServer, name, motd, maxClients });
  }

  setClientDescription(fingerprint: string, description: string): void {
    this.connection.send({ t: Op.SetClientDescription, fingerprint, description });
  }

  setProfile(input: UserProfile): void {
    const fingerprint = this.identity?.fingerprint ?? '';
    if (!fingerprint) return;
    const profile = normalizeProfile({ ...input, fingerprint, updatedAt: Date.now() });
    this.profiles.set(fingerprint, profile);
    saveLocalProfile(profile);
    this.connection.send({
      t: Op.SetProfile,
      avatar: profile.avatar,
      border: profile.border,
      accent: profile.accent,
      statusText: profile.statusText,
      banner: profile.banner ?? '',
      bannerStyle: profile.bannerStyle ?? 'signature',
    });
    this.onChange();
  }

  /** ProfileUpdate é a confirmação de que a origem persistiu a alteração. */
  publishProfile(input: UserProfile): Promise<void> {
    if (this.link !== 'online' || !this.identity) return Promise.reject(new Error('Você está offline. Reconecte para publicar o perfil.'));
    if (this.pendingProfile) return Promise.reject(new Error('Sincronizando com o servidor…'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.finishProfileSave(new Error('O servidor não confirmou o perfil. Tente novamente.')), 10_000);
      this.pendingProfile = { resolve, reject, timer, expected: normalizeProfile(input) };
      try { this.setProfile(input); }
      catch { this.finishProfileSave(new Error('Não foi possível salvar o perfil. Tente novamente.')); }
    });
  }

  private finishProfileSave(error?: Error): void {
    const pending = this.pendingProfile;
    if (!pending) return;
    this.pendingProfile = null;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve();
  }

  setPermission(action: PermissionAction, minGroup: Group): void {
    this.connection.send({ t: Op.SetPermission, action, minGroup });
  }

  /**
   * Troca o preset do servidor (Dono). `custom` vazio aplica um embutido;
   * preenchido, importa o JSON e o `presetId` e ignorado pelo servidor.
   */
  setPreset(presetId: string, custom = ''): void {
    this.connection.send({ t: Op.SetPreset, presetId, custom });
  }

  /** Grupo minimo pra `action`. Consulta override do server; senao default. */
  permissionFor(action: PermissionAction): Group {
    return this.permissions.get(action) ?? DEFAULT_PERMISSIONS[action];
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

  awayMessage = '';

  setAway(away: boolean, message = ''): void {
    this.awayMessage = message;
    if (away) this.setFlags(this.flags | ClientFlags.Away);
    else this.setFlags(this.flags & ~ClientFlags.Away);
  }

  toggleAway(): void {
    this.setFlags(this.flags ^ ClientFlags.Away);
    if (!(this.flags & ClientFlags.Away)) this.awayMessage = '';
  }

  private setFlags(flags: number): void {
    const previous = this.flags;
    this.connection.send({ t: Op.SetSelfState, flags });
    this.playFlagChange(previous, flags);
    if (this.mixer) this.mixer.volume = flags & ClientFlags.MutedSpeakers ? 0 : this.outputVolume;
    this.liveKitVoice.setMutedSpeakers(Boolean(flags & ClientFlags.MutedSpeakers));
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
    this.liveKitVoice.setMuted(this.microphone.muted);
    this.liveKitVoice.setTransmissionEnabled(this.microphone.transmitting);
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

  channelMessages(channelId = this.self?.channelId ?? 0): ChatLine[] {
    return this.chat.filter((m) =>
      m.scope === ChatScope.Server ||
      (m.scope === ChatScope.Channel && m.targetId === channelId),
    );
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
        this.maxClients = m.maxClients;
        this.myGroup = m.group;
        if (this.favorite) touchFavorite(this.favorite.id);
        this.play('connected');
        break;

      case Op.Snapshot:
        this.channels.clear();
        this.clients.clear();
        this.claims.clear();
        for (const c of m.channels) this.channels.set(c.id, c);
        for (const c of m.clients) {
          this.clients.set(c.id, c);
          this.applyPeerPrefs(c);
        }
        for (const claim of m.claims) this.claims.set(claim.id, claim);
        void this.startMic();
        this.syncMicMute();
        // Pede aos compartilhadores já presentes que reenviem seu estado de
        // transmissão para quem acabou de entrar.
        this.screen.syncPresence();
        if (!this.profileSentForConnection && this.identity) {
          this.profileSentForConnection = true;
          const local = loadLocalProfile(this.identity.fingerprint);
          if (local) {
            // Mostra o cache imediatamente, mas aguarda o servidor responder
            // antes de publicar. Assim um cache antigo deste dispositivo não
            // sobrescreve um perfil mais novo salvo em outro dispositivo.
            this.profiles.set(local.fingerprint, local);
            const generation = this.connectGeneration;
            setTimeout(() => {
              if (generation !== this.connectGeneration || this.link !== 'online') return;
              if (!this.profileReceivedForConnection) this.setProfile(local);
            }, 500);
          }
        }
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
        // Novo cliente no meu canal? Se estou compartilhando tela, oferecer.
        if (isNew && this.self && m.client.channelId === this.self.channelId) {
          this.screen.onPeerReachable(m.client.id);
        }
        break;
      }

      case Op.ClientRemove: {
        const departed = this.clients.get(m.clientId);
        const dm = this.dmTabs.get(m.clientId);
        if (departed && dm) {
          this.chat.push({
            scope: ChatScope.Private,
            senderId: 0,
            targetId: m.clientId,
            senderName: 'system',
            text: `${departed.nickname} está offline no momento.`,
            stamp: Date.now(),
          });
          if (this.chat.length > MAX_CHAT_LINES) this.chat.shift();
        }
        this.clients.delete(m.clientId);
        this.mixer?.remove(m.clientId);
        this.screen.onPeerLeft(m.clientId);
        this.play('leave');
        break;
      }

      case Op.ClientMove: {
        const c = this.clients.get(m.clientId);
        if (c) c.channelId = m.channelId;
        if (m.clientId === this.selfId) {
          this.stopLiveKitFallback();
          this.play('channel');
          this.syncMicMute();
          // Mudei de canal — recalcula oferta de tela para o novo grupo.
          this.screen.onSelfMoved();
        } else if (this.self && m.channelId === this.self.channelId) {
          // Alguem se moveu para o meu canal — oferece tela se estou compartilhando.
          this.screen.onPeerReachable(m.clientId);
        }
        break;
      }

      case Op.ClientState: {
        const c = this.clients.get(m.clientId);
        const previous = c?.flags ?? (m.clientId === this.selfId ? this.flags : m.flags);
        if (c) c.flags = m.flags;
        if (m.clientId === this.selfId) {
          this.playFlagChange(previous, m.flags);
          this.syncMicMute();
        }
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
        const isClaimNotice = m.senderId === 0 && m.scope === ChatScope.Server
          && /claimou|assumiu|liberou|entrou na fila/i.test(m.text);
        if (isPoke) {
          this.play('poke');
          const pokeMatch = m.text.match(/👉\s*(.+?)\s+(?:te cutucou|cutucou todo[^:]*?)(?::\s*(.+))?$/);
          const from = pokeMatch?.[1] ?? 'Alguém';
          const customMsg = pokeMatch?.[2] ?? '';
          this.onPoke?.(from, customMsg);
          if (this.notificationsEnabled) notifications.poke(from);
        } else if (isClaimNotice) {
          this.play('claim');
        } else if (m.senderId !== this.selfId) {
          if (m.scope === ChatScope.Private) {
            const otherId = m.senderId;
            const isNewTab = !this.dmTabs.has(otherId);
            if (isNewTab) {
              this.dmTabs.set(otherId, { clientId: otherId, name: m.senderName, unread: 0 });
            }
            // Primeira mensagem de alguem novo puxa foco pro chat dele —
            // como o WhatsApp. Se o usuario ja esta em outro DM ou tem
            // conversa em aberto, apenas incrementa o unread.
            if (isNewTab && this.activeDmTab === null) {
              this.activeDmTab = otherId;
            } else if (this.activeDmTab !== otherId) {
              const tab = this.dmTabs.get(otherId)!;
              tab.unread++;
            }
            // Aba ja focada quando a DM chega: confirma leitura imediatamente.
            if (this.activeDmTab === otherId) {
              queueMicrotask(() => this.markDmRead(otherId));
            }
            this.play('message');
            if (this.notificationsEnabled) notifications.privateMessage(m.senderName, m.text);
          } else {
            const channelChatFocused = this.activeDmTab === null;
            const visibleInCurrentChat = channelChatFocused && (
              m.scope === ChatScope.Server ||
              m.targetId === this.self?.channelId
            );
            if (!visibleInCurrentChat) this.unread++;
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

      case Op.RespClaims:
        this.claims.clear();
        for (const claim of m.claims) this.claims.set(claim.id, claim);
        break;

      case Op.BotState:
        this.botState = m.state;
        this.onBotStateChange?.();
        break;

      case Op.ChatReadDeliver: {
        const prev = this.dmReadStamps.get(m.readerId) ?? 0;
        if (m.upToStamp > prev) this.dmReadStamps.set(m.readerId, m.upToStamp);
        break;
      }

      case Op.PlayerInfoBatch:
        for (const info of m.infos) this.playerInfos.set(info.fingerprint, info);
        break;

      case Op.ProfileUpdate: {
        const profile = normalizeProfile(m.profile);
        this.profiles.set(profile.fingerprint, profile);
        if (profile.fingerprint === this.identity?.fingerprint) {
          this.profileReceivedForConnection = true;
          saveLocalProfile(profile);
          if (this.pendingProfile) {
            const expected = this.pendingProfile.expected;
            const matches = (['avatar', 'border', 'accent', 'statusText', 'banner', 'bannerStyle'] as const)
              .every((key) => profile[key] === expected[key]);
            this.finishProfileSave(matches ? undefined : new Error('O servidor não confirmou todas as alterações. Atualize o servidor e tente novamente.'));
          }
        }
        break;
      }

      case Op.Permissions:
        this.permissions.clear();
        for (const e of m.entries) this.permissions.set(e.action, e.minGroup);
        break;

      case Op.PresetState: {
        // Preset importado chega por JSON; embutido so pelo id.
        let next: ServerPreset | null = null;
        if (m.custom) {
          try {
            next = parsePreset(JSON.parse(m.custom));
          } catch {
            next = null;
          }
        }
        this.preset = next ?? findPreset(m.presetId) ?? findPreset(DEFAULT_PRESET_ID)!;
        this.presetId = m.presetId;
        break;
      }

      case Op.ScreenSignalDeliver:
        void this.screen.handleSignal(m.senderId, m.targetId, m.kind, m.data);
        break;

      case Op.GroupDefs:
        this.groupDefs = m.groups;
        break;

      case Op.ServerUpdate:
        this.serverName = m.name;
        this.motd = m.motd;
        this.maxClients = m.maxClients;
        break;

      case Op.Failure:
        this.finishProfileSave(new Error(m.message));
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

function downloadBlob(blob: Blob, filename: string): void {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function recordingFilename(startedAt: string, extension: string): string {
  const stamp = startedAt.replace(/[:.]/g, '-').replace(/[^0-9TZ-]/g, '');
  return `vox-channel-${stamp}.${extension}`;
}

function audioExtension(mimeType: string): string {
  return mimeType.includes('ogg') ? 'ogg' : 'webm';
}
