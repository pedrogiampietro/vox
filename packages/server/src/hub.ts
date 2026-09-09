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
  BotControlAction,
  CHALLENGE_BYTES,
  ChannelFlags,
  ChatScope,
  ClientFlags,
  DEFAULT_GROUP_DEFS,
  DEFAULT_PERMISSIONS,
  FailureCode,
  FrameKind,
  GROUP_NAMES,
  Group,
  NO_CHANNEL,
  Op,
  PROTOCOL_VERSION,
  PermissionAction,
  RemoveReason,
  VOICE_TOKEN_BYTES,
  decodeClientMessage,
  encodeServerMessage,
  stampSender,
  MAX_CHAT_TEXT,
  MAX_SCREEN_SIGNAL,
  MAX_NICKNAME,
  MAX_VOICE_PACKET,
  VOICE_HEADER_SIZE,
  DEFAULT_PRESET_ID,
  canonicalRespawnIn,
  findPreset,
  parsePreset,
  serializePreset,
} from '@vox/protocol';
import type { BotProvider, BotStateInfo, ChannelInfo, ClientInfo, ClientMessage, GroupDef, PermissionEntry, PlayerInfo, ProfileBorder, RespClaimInfo, PresetBotConfig, ServerMessage, ServerPreset, UserProfile, VoiceEdge } from '@vox/protocol';
import { applyBotConfig, startBot, stopBot, testBot } from './bot-ctrl.js';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { fingerprintOf, looksLikePublicKey, verifyChallenge } from './identity.js';
import type { StoredBan, StoredBotConfig, StoredChannel, StoredRespClaim, StoredServer } from './persistence.js';
import { DEFAULT_BOT_CONFIG } from './persistence.js';
import type { BotConfig } from '../../bot/src/bot.js';
import { Session, type PeerSocket, type VoiceSink, type VoiceState } from './session.js';
import { serverMetrics } from './metrics.js';
import { clean, clamp } from './util.js';
import type { VoiceRouter } from './voice-router.js';

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
  /** Avisa que algo persistente mudou (canais, grupos, banimentos). Debounce ~2s. */
  onChanged(): void;
  /** Forca gravacao imediata (sem debounce). Para mudancas onde uma perda de 2s doi. */
  forceSave(): void;
  claimVoiceKey(key: string, session: Session): void;
  releaseVoiceKey(key: string): void;
  voiceEndpoint(hostname: string, serverId?: number): { host: string; port: number; certHash: Uint8Array; edges?: VoiceEdge[] };
  voiceRouter?: VoiceRouter;
}

interface Channel {
  info: ChannelInfo;
  password: string;
  members: Set<Session>;
}

// Permissoes agora vem de hub.permissionFor(action). Dono ajusta via UI.

export class Hub {
  private readonly channels = new Map<number, Channel>();
  /**
   * Lista estável para o caminho quente da voz. O Set continua sendo a fonte
   * de verdade para as operações de canal; este cache evita criar um iterador
   * novo para cada pacote e só é invalidado quando a composição do canal muda.
   */
  private readonly voiceMemberCache = new Map<number, Session[]>();
  /**
   * Atualizacoes de visibilidade para sessoes restritas sao agrupadas. Um
   * burst de entradas nao deve gerar um Snapshot completo por evento.
   */
  private readonly visibilityRefreshTimers = new Map<Session, ReturnType<typeof setTimeout>>();
  private readonly sessions = new Map<number, Session>();
  /** Conexoes abertas que ainda nao terminaram o handshake. */
  private readonly pending = new Set<Session>();
  /** Limita rajadas sem criar uma fila longa para entradas simultaneas. */
  private readonly authGate = new AsyncGate(32);
  private readonly nicknames = new Set<string>();
  private readonly groups = new Map<string, Group>();
  private readonly claims = new Map<number, StoredRespClaim>();
  private groupDefs: GroupDef[];
  private bans: StoredBan[] = [];
  private readonly descriptions = new Map<string, string>();
  private readonly profiles = new Map<string, UserProfile>();
  /** Cache do bot: nome do char (lower) -> info recente. */
  private readonly playerInfoByName = new Map<string, PlayerInfo>();
  /** Overrides sobre DEFAULT_PERMISSIONS. Ausencia = usar default. */
  private readonly permissions = new Map<PermissionAction, Group>();
  private presetId: string;
  /** Preenchido so pra presets importados; embutidos vem de findPreset(). */
  private customPreset: ServerPreset | null;

  afkEnabled = config.afkEnabled;

  /** Referencia ao bot do provider ativo, quando ligado. */
  rubinot: {
    addHunted(n: string): void;
    removeHunted(n: string): void;
    clearHunted(): void;
    huntedList: string[];
    manualHuntedList: string[];
    friendsList: string[];
    enemiesList: string[];
    isRunning: boolean;
    start(): Promise<void>;
    stop(): void;
    restart(cfg: BotConfig): Promise<void>;
    config: BotConfig;
    isStarting: boolean;
    lastStartError: string;
  } | null = null;
  botConfig: StoredBotConfig;

  private nextClientId = 1;
  private nextChannelId = 1;

  constructor(
    public settings: ServerSettings,
    stored: Pick<StoredServer, 'channels' | 'groups' | 'bans' | 'groupDefs' | 'claims' | 'botConfig' | 'descriptions' | 'profiles' | 'permissions' | 'presetId' | 'customPreset'>,
    private readonly deps: HubDeps,
  ) {
    for (const c of stored.channels) {
      const { password, ...info } = c;
      // Servidores criados antes do flag de silencio ainda podem ter o AFK
      // persistido. Atualiza em memoria para que ele ja nasca sem voz.
      if (info.name === config.afkChannelName) info.flags |= ChannelFlags.VoiceDisabled;
      this.seedChannel(info, password);
    }
    for (const [fp, group] of Object.entries(stored.groups)) this.groups.set(fp, group);
    for (const claim of stored.claims ?? []) this.claims.set(claim.id, claim);
    this.groupDefs = stored.groupDefs?.length ? [...stored.groupDefs] : [...DEFAULT_GROUP_DEFS];
    this.bans = [...stored.bans];
    this.botConfig = stored.botConfig ? { ...stored.botConfig } : { ...DEFAULT_BOT_CONFIG };
    for (const [fp, desc] of Object.entries(stored.descriptions ?? {})) {
      if (typeof desc === 'string' && desc) this.descriptions.set(fp, desc);
    }
    for (const [fp, profile] of Object.entries(stored.profiles ?? {})) {
      if (profile?.fingerprint === fp) this.profiles.set(fp, profile);
    }
    for (const [k, v] of Object.entries(stored.permissions ?? {})) {
      const action = Number(k) as PermissionAction;
      if (typeof v === 'number') this.permissions.set(action, v as Group);
    }
    this.customPreset = stored.customPreset ?? null;
    this.presetId = this.customPreset?.id ?? (stored.presetId || DEFAULT_PRESET_ID);
  }

  // --------------------------------------------------------------- preset --

  /**
   * Preset em vigor. Importado ganha do embutido; se o id nao resolve mais
   * (preset removido do codigo entre deploys) cai no padrao, porque um servidor
   * sem preset nao teria catalogo de respawn nenhum.
   */
  activePreset(): ServerPreset {
    if (this.customPreset) return this.customPreset;
    return findPreset(this.presetId) ?? findPreset(DEFAULT_PRESET_ID)!;
  }

  /** Troca um preset embutido pelo painel, sem expor presets arbitrários. */
  setBuiltinPresetFromAdmin(presetId: string): boolean {
    const preset = findPreset(clean(presetId, 48));
    if (!preset) return false;
    this.applyPreset(preset, false);
    return true;
  }

  private presetStateMessage(): ServerMessage {
    const preset = this.activePreset();
    return {
      t: Op.PresetState,
      presetId: preset.id,
      custom: this.customPreset ? (serializePreset(this.customPreset) ?? '') : '',
    };
  }

  private setPreset(s: Session, presetId: string, custom: string): void {
    if (s.group < Group.Dono) return this.fail(s, FailureCode.NotPermitted, 'so o dono troca o preset');

    if (custom) {
      let parsed: ServerPreset | null = null;
      try {
        parsed = parsePreset(JSON.parse(custom));
      } catch {
        parsed = null;
      }
      if (!parsed) return this.fail(s, FailureCode.Malformed, 'preset invalido ou grande demais');
      this.applyPreset(parsed, true);
      return;
    } else {
      const builtin = findPreset(clean(presetId, 48));
      if (!builtin) return this.fail(s, FailureCode.Malformed, 'preset desconhecido');
      this.applyPreset(builtin, false);
      return;
    }
  }

  private applyPreset(preset: ServerPreset, custom: boolean): void {
    const previousProvider = this.activePreset().bot.provider;
    this.customPreset = custom ? preset : null;
    this.presetId = preset.id;

    // Claims do preset antigo apontariam pra respawns que sumiram do catalogo;
    // manter isso deixaria o painel com linhas impossiveis de liberar.
    for (const [id, claim] of [...this.claims]) {
      if (!canonicalRespawnIn(preset, claim.respawn)) this.claims.delete(id);
    }

    this.retargetBot(previousProvider, preset.bot);

    this.broadcast(this.presetStateMessage());
    this.broadcast({ t: Op.RespClaims, claims: this.claimList() });
    this.broadcast({ t: Op.BotState, state: this.botState() });
    this.deps.forceSave();
  }

  /**
   * Reaponta o bot quando o preset troca a fonte de dados.
   *
   * O world configurado pertence ao OT anterior — "Drakaria" nao existe no
   * DeusOT — e um world que a fonte nao reconhece faz o bot rodar sem nunca
   * casar nada, silenciosamente. Preferimos parar e limpar: o dono escolhe o
   * mundo novo na aba Bot e liga de novo, sabendo o que esta fazendo.
   */
  private retargetBot(previous: BotProvider, bot: PresetBotConfig): void {
    if (previous === bot.provider) return;

    this.rubinot?.stop();
    // Descartado de proposito: o provider e fixo na instancia, entao o bot
    // precisa ser reconstruido pra passar a ler do OT novo.
    this.rubinot = null;
    this.botConfig = {
      ...this.botConfig,
      world: bot.world ?? '',
      channelName: bot.channelName ?? this.botConfig.channelName,
      enabled: false,
    };
    console.log(
      `[bot] preset trocou a fonte (${previous} -> ${bot.provider}); bot parado, defina o world e ligue de novo`,
    );
    this.deps.onChanged();
  }

  /** Grupo minimo pra executar `action`. Vem do override, senao do default. */
  permissionFor(action: PermissionAction): Group {
    return this.permissions.get(action) ?? DEFAULT_PERMISSIONS[action];
  }

  /** Lista completa (action, minGroup) pra broadcast/UI. */
  permissionList(): PermissionEntry[] {
    return (Object.keys(DEFAULT_PERMISSIONS) as unknown as string[])
      .map((k) => Number(k) as PermissionAction)
      .filter((a) => !Number.isNaN(a) && a in DEFAULT_PERMISSIONS)
      .map((action) => ({ action, minGroup: this.permissionFor(action) }));
  }

  setPermission(action: PermissionAction, minGroup: Group): void {
    if (!(action in DEFAULT_PERMISSIONS)) return;
    if (minGroup === DEFAULT_PERMISSIONS[action]) {
      this.permissions.delete(action);
    } else {
      this.permissions.set(action, minGroup);
    }
    this.deps.onChanged();
    this.broadcast({ t: Op.Permissions, entries: this.permissionList() });
    this.refreshVisibilitySnapshots();
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
    return [...this.sessions.values()].map((s) => this.describe(s));
  }

  /**
   * Spy pode continuar sendo movido por moderador, mas nao recebe a arvore
   * inteira nem a lista global de usuarios. Se estiver em um canal, enxerga
   * somente o caminho ate ele e os membros do proprio canal.
   */
  private canViewChannels(s: Session): boolean {
    if (s.group === Group.Spy) return false;
    return s.group >= this.permissionFor(PermissionAction.ViewChannels);
  }

  /** Entrada voluntaria e separada da visibilidade: o owner pode configurar
   * uma regra diferente, mas o grupo Spy continua dependendo de pull. */
  private canJoinChannels(s: Session): boolean {
    if (s.group === Group.Spy) return false;
    return s.group >= this.permissionFor(PermissionAction.JoinChannel);
  }

  private channelListFor(s: Session): ChannelInfo[] {
    if (this.canViewChannels(s)) return this.channelList;

    const visible = new Map<number, ChannelInfo>();
    let current = this.channels.get(s.channelId);
    while (current) {
      visible.set(current.info.id, current.info);
      current = this.channels.get(current.info.parentId);
    }
    return [...visible.values()].sort((a, b) => a.order - b.order || a.id - b.id);
  }

  private clientListFor(s: Session): ClientInfo[] {
    if (this.canViewChannels(s)) return this.clientList();
    return [...this.sessions.values()]
      .filter((other) => other.id === s.id || (s.channelId !== NO_CHANNEL && other.channelId === s.channelId))
      .map((other) => this.describe(other));
  }

  private sendVisibilitySnapshot(s: Session): void {
    if (!this.isLive(s)) return;
    const clients = this.clientListFor(s);
    s.send(encodeServerMessage({
      t: Op.Snapshot,
      channels: this.channelListFor(s),
      clients,
      claims: this.claimList(),
    }));
    this.sendProfilesForClients(s, clients);
  }

  /** Perfis viajam em frames individuais para não transformar Snapshot em MBs. */
  private sendProfilesForClients(target: Session, clients: ClientInfo[]): void {
    const sent = new Set<string>();
    for (const client of clients) {
      if (!client.fingerprint || sent.has(client.fingerprint)) continue;
      sent.add(client.fingerprint);
      const profile = this.profiles.get(client.fingerprint);
      if (profile) target.send(encodeServerMessage({ t: Op.ProfileUpdate, profile }));
    }
  }

  private broadcastProfile(profile: UserProfile): void {
    const frame = encodeServerMessage({ t: Op.ProfileUpdate, profile });
    for (const target of this.sessions.values()) {
      const visible = this.canViewChannels(target)
        || this.clientListFor(target).some((client) => client.fingerprint === profile.fingerprint);
      if (visible) target.send(frame);
    }
  }

  private refreshVisibilitySnapshots(): void {
    for (const s of this.sessions.values()) {
      if (!this.canViewChannels(s)) this.scheduleVisibilitySnapshot(s);
    }
  }

  /**
   * Um pequeno debounce transforma uma rajada de eventos em um unico retrato
   * filtrado por sessao. Isso preserva a privacidade do Spy sem repetir o
   * mesmo trabalho dezenas de vezes durante uma entrada em massa.
   */
  private scheduleVisibilitySnapshot(s: Session): void {
    if (this.canViewChannels(s) || !this.isLive(s) || this.visibilityRefreshTimers.has(s)) return;
    const timer = setTimeout(() => {
      this.visibilityRefreshTimers.delete(s);
      this.sendVisibilitySnapshot(s);
    }, 75);
    timer.unref?.();
    this.visibilityRefreshTimers.set(s, timer);
  }

  private cancelVisibilitySnapshot(s: Session): void {
    const timer = this.visibilityRefreshTimers.get(s);
    if (!timer) return;
    clearTimeout(timer);
    this.visibilityRefreshTimers.delete(s);
  }

  // ------------------------------------------------ player info (provider) --

  /**
   * Extrai "Main: <nome>" das descricoes armazenadas. Retorna map de
   * nome-lowercase -> fingerprints[]. O bot itera essa lista pra saber quais
   * chars procurar no worldOnline do provider ativo.
   */
  trackedMains(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const [fp, desc] of this.descriptions) {
      const key = extractMain(desc);
      if (!key) continue;
      const arr = out.get(key);
      if (arr) arr.push(fp);
      else out.set(key, [fp]);
    }
    return out;
  }

  /**
   * Merge de player info (bot chama a cada poll). Aciona broadcast quando algo
   * mudou (level/vocation/online) para os clientes reagirem sem re-fetch.
   */
  updatePlayerInfo(nameLower: string, patch: Partial<PlayerInfo> & { name: string }): void {
    const now = Date.now();
    const prev = this.playerInfoByName.get(nameLower);
    // Encontra fingerprints com esse main.
    const mains = this.trackedMains();
    const fingerprints = mains.get(nameLower) ?? [];
    if (fingerprints.length === 0) {
      // Ninguem mais tem esse Main: X — descarta.
      this.playerInfoByName.delete(nameLower);
      return;
    }
    const merged: PlayerInfo = {
      fingerprint: fingerprints[0]!, // representativo; broadcast repassa por nome
      name: patch.name,
      vocation: patch.vocation ?? prev?.vocation ?? '',
      level: patch.level ?? prev?.level ?? 0,
      online: patch.online ?? prev?.online ?? false,
      updatedAt: now,
    };
    const unchanged = prev
      && prev.vocation === merged.vocation
      && prev.level === merged.level
      && prev.online === merged.online
      && prev.name === merged.name;
    this.playerInfoByName.set(nameLower, merged);
    if (unchanged) return;
    // Broadcast por fingerprint (multiplo se varios usuarios tem o mesmo main).
    const infos: PlayerInfo[] = fingerprints.map((fp) => ({ ...merged, fingerprint: fp }));
    this.broadcast({ t: Op.PlayerInfoBatch, infos });
  }

  /** Snapshot pra sessao recem-conectada. */
  playerInfoList(): PlayerInfo[] {
    const mains = this.trackedMains();
    const out: PlayerInfo[] = [];
    for (const [name, info] of this.playerInfoByName) {
      const fps = mains.get(name) ?? [];
      for (const fp of fps) out.push({ ...info, fingerprint: fp });
    }
    return out;
  }

  private describe(s: Session): ClientInfo {
    return {
      id: s.id,
      channelId: s.channelId,
      nickname: s.nickname,
      flags: s.flags,
      group: s.group,
      fingerprint: s.fingerprint,
      connectedAt: s.connectedAt,
      platform: s.platform,
      description: this.descriptions.get(s.fingerprint) ?? '',
    };
  }

  banList(): StoredBan[] {
    this.pruneBans();
    return [...this.bans];
  }

  groupList(): Record<string, Group> {
    return Object.fromEntries(this.groups);
  }

  claimList(): RespClaimInfo[] {
    this.pruneClaims();
    return [...this.claims.values()]
      .sort((a, b) => a.expiresAt - b.expiresAt)
      .map((c) => ({
        id: c.id,
        respawn: c.respawn,
        note: c.note,
        ownerId: this.clientIdForFingerprint(c.ownerFingerprint),
        ownerName: c.ownerName,
        claimedAt: c.claimedAt,
        expiresAt: c.expiresAt,
        queue: c.queue.map((q) => ({
          clientId: this.clientIdForFingerprint(q.fingerprint),
          name: this.liveNameForFingerprint(q.fingerprint) || q.name,
        })),
      }));
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
      claims: [...this.claims.values()],
      botConfig: { ...this.botConfig, huntedNames: botHunted },
      descriptions: Object.fromEntries(this.descriptions),
      profiles: Object.fromEntries(this.profiles),
      permissions: Object.fromEntries(this.permissions),
      presetId: this.presetId,
      customPreset: this.customPreset,
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

  private voiceMembers(channel: Channel): Session[] {
    const cached = this.voiceMemberCache.get(channel.info.id);
    if (cached) return cached;
    const members = [...channel.members];
    this.voiceMemberCache.set(channel.info.id, members);
    return members;
  }

  private addMember(channel: Channel, session: Session): void {
    channel.members.add(session);
    this.voiceMemberCache.delete(channel.info.id);
  }

  private removeMember(channel: Channel, session: Session): void {
    channel.members.delete(session);
    this.voiceMemberCache.delete(channel.info.id);
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
    this.cancelVisibilitySnapshot(s);
    if (!this.isLive(s)) return;

    const previousChannelId = s.channelId;
    this.deps.voiceRouter?.unregister(s);
    this.leaveChannel(s);
    this.sessions.delete(s.id);
    this.nicknames.delete(s.nickname.toLowerCase());
    if (s.voiceKey) this.deps.releaseVoiceKey(s.voiceKey);
    s.voiceKey = '';
    s.voice?.close();
    s.voice = null;
    s.stage = 'new';
    this.broadcastClientRemove(s, previousChannelId, reason);
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
    if (this.pruneClaims(now)) this.broadcastClaims();
  }

  private checkAfkOnMute(s: Session): void {
    const bothMuted = (s.flags & ClientFlags.MutedMic) !== 0
      && (s.flags & ClientFlags.MutedSpeakers) !== 0;
    const afkCh = [...this.channels.values()].find((ch) => ch.info.name === config.afkChannelName)
      ?? (this.afkEnabled ? this.findOrCreateAfkChannel() : null);
    if (!afkCh) return;
    if (bothMuted) {
      if (!this.afkEnabled) return;
      if (s.channelId === afkCh.info.id) return;
      s.afkReturnChannelId = s.channelId;
      this.forceMove(s, afkCh.info.id);
      return;
    }

    // Ao voltar a ouvir/falar, retorna somente se a ida ao AFK foi feita
    // automaticamente por este mecanismo. Um AFK manual continua manual.
    if (s.channelId !== afkCh.info.id || s.afkReturnChannelId === NO_CHANNEL) return;
    const returnChannelId = s.afkReturnChannelId;
    s.afkReturnChannelId = NO_CHANNEL;
    if (this.channels.has(returnChannelId)) this.forceMove(s, returnChannelId);
  }

  private findOrCreateAfkChannel(): Channel | null {
    const name = config.afkChannelName;
    for (const ch of this.channels.values()) {
      if (ch.info.name !== name) continue;
      if (!(ch.info.flags & ChannelFlags.VoiceDisabled)) {
        ch.info.flags |= ChannelFlags.VoiceDisabled;
        this.broadcast({ t: Op.ChannelUpdate, channel: ch.info });
        this.deps.onChanged();
      }
      return ch;
    }
    const info: ChannelInfo = {
      id: this.allocChannelId(),
      parentId: NO_CHANNEL,
      order: this.channels.size,
      name,
      topic: 'Canal AFK',
      maxClients: 0,
      flags: ChannelFlags.Permanent | ChannelFlags.VoiceDisabled,
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
      serverMetrics.recordInbound('voice', frame.byteLength);
      if (!s.voiceLimit.take(now)) return;
      this.routeVoice(s, frame);
      return;
    }
    serverMetrics.recordInbound('control', frame.byteLength);
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
    if (channel.info.flags & ChannelFlags.VoiceDisabled) return;

    if (channel.info.flags & ChannelFlags.Moderated) {
      if (s.group < Group.Moderator && !(s.flags & ClientFlags.HasVoice)) return;
    }

    stampSender(frame, s.id);
    if (this.deps.voiceRouter?.route(s, channel.info.id, frame)) return;
    // O edge ja entregou este frame aos clientes da mesma regiao. Reenviar
    // para eles pela origem so cria trafego e trabalho que o edge descarta ao
    // reconhecer o proprio eco. Clientes sem edgeId continuam no caminho
    // normal, preservando a compatibilidade com edges antigos.
    const sourceEdgeId = s.voice?.edgeId;
    let recipients = 0;
    const groupedEdges = new Map<string, VoiceSink>();
    const members = this.voiceMembers(channel);
    for (let i = 0; i < members.length; i++) {
      const peer = members[i]!;
      if (peer === s) continue;
      if (sourceEdgeId && peer.voice?.edgeId === sourceEdgeId) continue;
      if (peer.flags & ClientFlags.MutedSpeakers) continue;
      recipients++;
      const peerVoice = peer.voice;
      const groupId = peerVoice?.voiceGroupId;
      if (groupId && peerVoice.sendChannel) {
        groupedEdges.set(groupId, peerVoice);
        continue;
      }
      // A contabilidade do fan-out acontece uma vez abaixo, depois que o
      // conjunto de destinos foi filtrado. Isso reduz trabalho por pacote sem
      // mudar o comportamento do transporte nem da fila de cada cliente.
      peer.sendVoice(frame, false);
    }
    for (const sink of groupedEdges.values()) sink.sendChannel!(channel.info.id, frame);
    serverMetrics.recordVoiceFanout(frame.byteLength, recipients, `${this.id}:${channel.info.id}`);
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
          this.syncVoiceState(s);
          this.broadcast({ t: Op.ClientState, clientId: s.id, flags });
          this.checkAfkOnMute(s);
        }
        if (m.nickname !== undefined) {
          const nick = clean(m.nickname, MAX_NICKNAME) || 'convidado';
          if (nick !== s.nickname) {
            s.nickname = nick;
            this.broadcast({ t: Op.ClientAdd, client: this.describe(s) });
          }
        }
        break;
      }

      case Op.JoinChannel:
        this.joinChannel(s, m.channelId, m.password);
        break;

      case Op.CreateChannel:
        if (!this.allow(s, this.permissionFor(PermissionAction.CreateTempChannel))) break;
        this.createChannel(s, m.name, m.parentId, m.maxClients, m.password);
        break;

      case Op.DeleteChannel:
        if (!this.allow(s, this.permissionFor(PermissionAction.DeleteChannel))) break;
        this.deleteChannel(s, m.channelId);
        break;

      case Op.EditChannel: {
        if (!this.allow(s, this.permissionFor(PermissionAction.EditChannel))) break;
        const ch = this.channels.get(m.channelId);
        if (!ch) return this.fail(s, FailureCode.ChannelNotFound, 'canal inexistente');
        ch.info.name = clean(m.name, 64) || ch.info.name;
        ch.info.topic = clean(m.topic, 128);
        ch.info.maxClients = clamp(m.maxClients, 0, 512);
        this.broadcast({ t: Op.ChannelUpdate, channel: ch.info });
        this.deps.onChanged();
        break;
      }

      case Op.MoveChannel:
        if (!this.allow(s, this.permissionFor(PermissionAction.MoveChannel))) break;
        this.moveChannel(s, m.channelId, m.parentId, m.beforeChannelId);
        break;

      case Op.ChatSend:
        this.routeChat(s, m.scope, m.targetId, m.text);
        break;

      case Op.KickClient: {
        const target = this.targetFor(s, m.clientId, this.permissionFor(PermissionAction.Kick));
        if (target) this.expel(target, RemoveReason.Kicked, clean(m.reason, 120) || 'expulso');
        break;
      }

      case Op.BanClient: {
        const target = this.targetFor(s, m.clientId, this.permissionFor(PermissionAction.Ban));
        if (target) this.banSession(target, m.minutes, clean(m.reason, 120) || 'banido');
        break;
      }

      case Op.MoveClient: {
        const target = this.targetForMove(s, m.clientId);
        if (target) this.forceMove(target, m.channelId);
        break;
      }

      case Op.SetClientGroup: {
        // Atribuir cargos e uma operacao de administracao do servidor: nem
        // Admin nem Leader podem criar, rebaixar ou promover grupos.
        const target = this.targetFor(s, m.clientId, Group.Dono);
        if (!target) break;
        if (!Number.isInteger(m.group) || m.group < Group.Guest || m.group > Group.Dono) {
          return this.fail(s, FailureCode.Malformed, 'grupo invalido');
        }
        this.assignGroup(target, m.group);
        break;
      }

      case Op.SetGroupDef: {
        if (s.group < Group.Dono) {
          return this.fail(s, FailureCode.NotPermitted, 'apenas o dono pode editar grupos');
        }
        if (!Number.isInteger(m.group) || m.group < Group.Guest || m.group > Group.Dono) {
          return this.fail(s, FailureCode.Malformed, 'grupo invalido');
        }
        const def: GroupDef = { id: m.group, name: clean(m.name, 32) || 'Grupo', icon: m.icon, color: clean(m.color, 9) };
        const idx = this.groupDefs.findIndex((g) => g.id === m.group);
        if (idx >= 0) this.groupDefs[idx] = def;
        else this.groupDefs.push(def);
        this.broadcast({ t: Op.GroupDefs, groups: this.groupDefs });
        this.deps.onChanged();
        break;
      }

      case Op.EditServer: {
        if (!this.allow(s, Group.Dono)) break;
        this.settings.name = clean(m.name, 64) || this.settings.name;
        this.settings.motd = clean(m.motd, 256);
        // A capacidade pertence ao plano e só pode ser alterada pelo painel
        // master. O campo legado do frame é ignorado deliberadamente.
        this.deps.forceSave();
        this.broadcast({
          t: Op.ServerUpdate,
          name: this.settings.name,
          motd: this.settings.motd,
          maxClients: this.settings.maxClients,
        });
        break;
      }

      case Op.BotCommand: {
        this.handleBotCommand(s, m.command, m.args);
        break;
      }

      case Op.ClaimResp:
        this.claimResp(s, m.respawn, m.note);
        break;

      case Op.ReleaseResp:
        this.releaseResp(s, m.claimId);
        break;

      case Op.JoinRespQueue:
        this.joinRespQueue(s, m.claimId);
        break;

      case Op.LeaveRespQueue:
        this.leaveRespQueue(s, m.claimId);
        break;

      case Op.GetBotState:
        if (!this.allow(s, Group.Dono)) break;
        s.send(encodeServerMessage({ t: Op.BotState, state: this.botState() }));
        break;

      case Op.UpdateBotConfig: {
        if (!this.allow(s, Group.Dono)) break;
        const bc = this.botConfig;
        bc.world = clean(m.world, 32);
        bc.guildName = clean(m.guildName, 64);
        bc.channelName = clean(m.channelName, 32) || 'bot';
        bc.intervalMs = Math.max(m.intervalMs || 60_000, 10_000);
        bc.enabled = m.enabled;
        bc.globalDeaths = m.globalDeaths;
        bc.globalKills = m.globalKills;
        bc.globalLevelMin = clamp(m.globalLevelMin, 0, 4000);
        bc.summarizePresence = m.summarizePresence;
        bc.presenceSummaryMs = Math.max(m.presenceSummaryMs || 5 * 60_000, 60_000);
        bc.alertEnemyDeath = m.alertEnemyDeath;
        bc.alertFriendDeath = m.alertFriendDeath;
        bc.alertFriendLevelUp = m.alertFriendLevelUp;
        bc.alertEnemyLevelUp = m.alertEnemyLevelUp;
        bc.alertEnemyOnline = m.alertEnemyOnline;
        bc.alertEnemyOffline = m.alertEnemyOffline;
        this.deps.onChanged();
        void applyBotConfig(this).catch((err) => console.error('[bot] falha ao aplicar configuração:', err));
        this.broadcastBotState();
        break;
      }

      case Op.BotControl: {
        if (!this.allow(s, Group.Dono)) break;
        this.applyBotControl(s, m.action, m.name);
        break;
      }

      case Op.ChatRead: {
        // Confirmacao de leitura de DM: encaminha ao remetente. Nao precisa
        // persistir; se o remetente estiver offline, o read simplesmente se
        // perde — o receptor confirma de novo ao reabrir a aba.
        const target = this.sessions.get(m.targetId);
        if (!target || target === s) break;
        target.send(encodeServerMessage({
          t: Op.ChatReadDeliver,
          readerId: s.id,
          upToStamp: m.upToStamp,
        }));
        break;
      }

      case Op.ScreenSignal:
        this.routeScreenSignal(s, m.targetId, m.kind, m.data);
        break;

      case Op.SetPermission: {
        if (s.group < Group.Dono) {
          return this.fail(s, FailureCode.NotPermitted, 'apenas o dono configura permissoes');
        }
        if (!(m.action in DEFAULT_PERMISSIONS)
          || !Number.isInteger(m.minGroup)
          || m.minGroup < Group.Guest
          || m.minGroup > Group.Dono) {
          return this.fail(s, FailureCode.Malformed, 'permissao ou grupo invalido');
        }
        this.setPermission(m.action, m.minGroup);
        break;
      }

      case Op.SetPreset:
        this.setPreset(s, m.presetId, m.custom);
        break;

      case Op.SetClientDescription: {
        // Sua propria descricao voce sempre edita. A de outros depende de permissao.
        const isSelf = m.fingerprint === s.fingerprint;
        if (!isSelf && s.group < this.permissionFor(PermissionAction.SetOtherDescription)) {
          return this.fail(s, FailureCode.NotPermitted, 'permissao insuficiente para editar descricao alheia');
        }
        const desc = clean(m.description, 200);
        const fp = clean(m.fingerprint, 128);
        if (!fp) return this.fail(s, FailureCode.Malformed, 'fingerprint invalido');

        // Captura o Main antigo pra saber se precisamos limpar cache do player info.
        const prevDesc = this.descriptions.get(fp) ?? '';
        const prevMain = extractMain(prevDesc);

        if (desc) this.descriptions.set(fp, desc);
        else this.descriptions.delete(fp);
        // Save imediato: sem debounce, evita perder descricao se o server
        // reiniciar nos 2s seguintes (deploy, crash, etc.).
        this.deps.forceSave();

        // Reannounce todos com esse fingerprint (pode ter varias sessoes).
        for (const other of this.sessions.values()) {
          if (other.fingerprint === fp) this.broadcast({ t: Op.ClientAdd, client: this.describe(other) });
        }

        // Cache do PlayerInfo eh por nome. Se o Main mudou, o info antigo pra
        // este fingerprint fica orfao — envia um "clear" pros clientes.
        const newMain = extractMain(desc);
        if (prevMain && prevMain !== newMain) {
          // Se ninguem mais tem esse Main, purga do cache do hub.
          const mains = this.trackedMains();
          if (!mains.has(prevMain)) this.playerInfoByName.delete(prevMain);
          // Manda pro cliente uma PlayerInfo vazia pra ele apagar a linha.
          this.broadcast({
            t: Op.PlayerInfoBatch,
            infos: [{ fingerprint: fp, name: '', vocation: '', level: 0, online: false, updatedAt: Date.now() }],
          });
        }
        break;
      }

      case Op.SetProfile: {
        if (!s.fingerprint) return this.fail(s, FailureCode.NotPermitted, 'identidade obrigatoria para editar o perfil');
        const avatar = validProfileAvatar(m.avatar) ? m.avatar : '';
        if (m.avatar && !avatar) return this.fail(s, FailureCode.Malformed, 'avatar invalido ou muito grande');
        const profile: UserProfile = {
          fingerprint: s.fingerprint,
          avatar,
          border: validProfileBorder(m.border),
          accent: /^#[0-9a-f]{6}$/i.test(m.accent) ? m.accent.toLowerCase() : '#e8a33d',
          statusText: clean(m.statusText, 64),
          updatedAt: Date.now(),
        };
        this.profiles.set(s.fingerprint, profile);
        this.deps.forceSave();
        this.broadcastProfile(profile);
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

    const ok = await this.authGate.run(() => verifyChallenge(s.publicKey, signature, nonce));
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

    const home = this.defaultChannel();
    // Spy fica fora de qualquer canal até ser puxado por um moderador. Isso
    // evita que o lobby inicial revele membros e conversas para ele.
    if (home && this.canViewChannels(s)) {
      this.addMember(home, s);
      s.channelId = home.info.id;
    }
    this.deps.voiceRouter?.register(s, this.voiceState(s));

    const voice = this.deps.voiceEndpoint(s.hostname, this.settings.id);
    s.send(
      encodeServerMessage({
        t: Op.Welcome,
        clientId: id,
        serverId: this.settings.id,
        serverName: this.settings.name,
        motd: this.settings.motd,
        maxClients: this.settings.maxClients,
        group: s.group,
        voiceToken: token,
        voiceHost: voice.host,
        wtPort: voice.port,
        wtCertHash: voice.certHash,
        voiceEdges: voice.edges ?? [{ host: voice.host, port: voice.port, region: voice.host, certHash: voice.certHash }],
      }),
    );

    const visibleClients = this.clientListFor(s);
    s.send(
      encodeServerMessage({
        t: Op.Snapshot,
        channels: this.channelListFor(s),
        clients: visibleClients,
        claims: this.claimList(),
      }),
    );
    this.sendProfilesForClients(s, visibleClients);
    s.send(encodeServerMessage({ t: Op.GroupDefs, groups: this.groupDefs }));
    s.send(encodeServerMessage({ t: Op.Permissions, entries: this.permissionList() }));
    s.send(encodeServerMessage(this.presetStateMessage()));
    if (s.group >= Group.Dono) {
      s.send(encodeServerMessage({ t: Op.BotState, state: this.botState() }));
    }
    const playerInfos = this.playerInfoList();
    if (playerInfos.length > 0) {
      s.send(encodeServerMessage({ t: Op.PlayerInfoBatch, infos: playerInfos }));
    }
    this.broadcast({ t: Op.ClientAdd, client: this.describe(s) }, s);
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
      if (known !== undefined && known >= Group.Dono) return known;
      this.groups.set(fingerprint, Group.Dono);
      this.deps.onChanged();
      console.log(`[vox] servidor ${this.settings.id}: ${fingerprint.slice(0, 12)} virou dono (admin login)`);
      return Group.Dono;
    }

    const known = this.groups.get(fingerprint);
    if (known !== undefined) return known;

    for (const g of this.groups.values()) if (g === Group.Dono) return Group.Guest;

    this.groups.set(fingerprint, Group.Dono);
    this.deps.onChanged();
    console.log(`[vox] servidor ${this.settings.id}: ${fingerprint.slice(0, 12)} virou dono`);
    return Group.Dono;
  }

  private assignGroup(target: Session, group: Group): void {
    const wasVisible = this.canViewChannels(target);
    if (group === Group.Guest) this.groups.delete(target.fingerprint);
    else this.groups.set(target.fingerprint, group);
    target.group = group;
    const isVisible = this.canViewChannels(target);
    this.syncVoiceState(target);
    this.deps.onChanged();
    // ClientAdd tambem serve de atualizacao: o cliente indexa por id.
    this.broadcast({ t: Op.ClientAdd, client: this.describe(target) });
    if (wasVisible !== isVisible) {
      if (isVisible) this.sendVisibilitySnapshot(target);
      else this.scheduleVisibilitySnapshot(target);
    }
  }

  /** Define o grupo de uma identidade que pode nem estar online. */
  setGroupByFingerprint(fingerprint: string, group: Group): void {
    if (group === Group.Guest) this.groups.delete(fingerprint);
    else this.groups.set(fingerprint, group);
    for (const s of this.sessions.values()) {
      if (s.fingerprint !== fingerprint) continue;
      const wasVisible = this.canViewChannels(s);
      s.group = group;
      const isVisible = this.canViewChannels(s);
      this.syncVoiceState(s);
      this.broadcast({ t: Op.ClientAdd, client: this.describe(s) });
      if (wasVisible !== isVisible) {
        if (isVisible) this.sendVisibilitySnapshot(s);
        else this.scheduleVisibilitySnapshot(s);
      }
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

  /** Move permite mesmo nivel: Dono move Dono, Admin move Admin. */
  private targetForMove(actor: Session, clientId: number): Session | null {
    if (!this.allow(actor, this.permissionFor(PermissionAction.Move))) return null;
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
    if (channelId !== this.afkChannelId()) target.afkReturnChannelId = NO_CHANNEL;
    const previousChannelId = target.channelId;
    this.leaveChannel(target);
    const ch = this.channels.get(channelId)!;
    this.addMember(ch, target);
    target.channelId = channelId;
    this.syncVoiceState(target);
    this.broadcastClientMove(target, previousChannelId, channelId);
  }

  /** Estado minimo que um edge precisa para encaminhar voz localmente. */
  voiceState(s: Session): VoiceState {
    return {
      channelId: s.channelId,
      channelFlags: this.channels.get(s.channelId)?.info.flags ?? 0,
      clientFlags: s.flags,
      group: s.group,
    };
  }

  private syncVoiceState(s: Session): void {
    s.voice?.updateState?.(this.voiceState(s));
    this.deps.voiceRouter?.update(s, this.voiceState(s));
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
    if (!this.canJoinChannels(s)) {
      return this.fail(s, FailureCode.NotPermitted, 'seu grupo nao pode entrar em canais por conta propria');
    }
    if (target.password && target.password !== password) {
      return this.fail(s, FailureCode.BadPassword, 'senha do canal incorreta');
    }
    if (target.info.maxClients > 0 && target.members.size >= target.info.maxClients) {
      return this.fail(s, FailureCode.ChannelFull, 'canal cheio');
    }

    const previousChannelId = s.channelId;
    this.leaveChannel(s);
    if (target.info.id !== this.afkChannelId()) s.afkReturnChannelId = NO_CHANNEL;
    if (s.flags & ClientFlags.HasVoice) {
      s.flags &= ~ClientFlags.HasVoice;
      this.broadcast({ t: Op.ClientState, clientId: s.id, flags: s.flags });
    }
    this.addMember(target, s);
    s.channelId = channelId;
    this.syncVoiceState(s);
    this.broadcastClientMove(s, previousChannelId, channelId);
  }

  private afkChannelId(): number {
    for (const ch of this.channels.values()) {
      if (ch.info.name === config.afkChannelName) return ch.info.id;
    }
    return NO_CHANNEL;
  }

  /** Tira a sessao do canal atual e recolhe canais temporarios vazios. */
  private leaveChannel(s: Session): void {
    const old = this.channels.get(s.channelId);
    if (!old) return;
    this.removeMember(old, s);
    s.channelId = NO_CHANNEL;
    this.syncVoiceState(s);
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
    const permanent = s.group >= this.permissionFor(PermissionAction.CreatePermanentChannel)
      ? ChannelFlags.Permanent
      : ChannelFlags.None;
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
      this.removeMember(ch, member);
      if (home) {
        this.addMember(home, member);
        member.channelId = home.info.id;
        this.syncVoiceState(member);
        this.broadcastClientMove(member, channelId, home.info.id);
      }
    }
    this.channels.delete(channelId);
    this.voiceMemberCache.delete(channelId);
    this.broadcast({ t: Op.ChannelRemove, channelId });
    this.deps.onChanged();
  }

  private moveChannel(s: Session, channelId: number, parentId: number, beforeChannelId = NO_CHANNEL): void {
    const channel = this.channels.get(channelId);
    if (!channel) return this.fail(s, FailureCode.ChannelNotFound, 'canal inexistente');
    if (channel.info.flags & ChannelFlags.Default) {
      return this.fail(s, FailureCode.NotPermitted, 'o canal padrao nao pode ser movido');
    }
    if (parentId !== NO_CHANNEL && !this.channels.has(parentId)) {
      return this.fail(s, FailureCode.ChannelNotFound, 'canal pai inexistente');
    }
    if (parentId === channelId || this.isChannelDescendant(parentId, channelId)) {
      return this.fail(s, FailureCode.NotPermitted, 'um canal nao pode ficar dentro dele mesmo');
    }

    const before = beforeChannelId === NO_CHANNEL ? undefined : this.channels.get(beforeChannelId);
    if (beforeChannelId !== NO_CHANNEL && (!before || before.info.parentId !== parentId || before.info.id === channelId)) {
      return this.fail(s, FailureCode.NotPermitted, 'posicao do canal invalida');
    }

    const oldParentId = channel.info.parentId;
    const oldSiblings = [...this.channels.values()]
      .filter((candidate) => candidate.info.parentId === oldParentId && candidate.info.id !== channelId)
      .sort((a, b) => a.info.order - b.info.order || a.info.id - b.info.id);
    const newSiblings = oldParentId === parentId
      ? oldSiblings
      : [...this.channels.values()]
        .filter((candidate) => candidate.info.parentId === parentId && candidate.info.id !== channelId)
        .sort((a, b) => a.info.order - b.info.order || a.info.id - b.info.id);

    const insertionIndex = before
      ? newSiblings.findIndex((candidate) => candidate.info.id === before.info.id)
      : newSiblings.length;
    if (insertionIndex < 0) return this.fail(s, FailureCode.NotPermitted, 'posicao do canal invalida');

    const reordered = [...newSiblings];
    reordered.splice(insertionIndex, 0, channel);

    const broadcastIfChanged = (candidate: Channel, nextParentId: number, nextOrder: number): void => {
      if (candidate.info.parentId === nextParentId && candidate.info.order === nextOrder) return;
      candidate.info.parentId = nextParentId;
      candidate.info.order = nextOrder;
      this.broadcast({ t: Op.ChannelUpdate, channel: candidate.info });
    };

    if (oldParentId !== parentId) {
      oldSiblings.forEach((candidate, index) => broadcastIfChanged(candidate, oldParentId, index));
    }
    reordered.forEach((candidate, index) => broadcastIfChanged(candidate, parentId, index));
    this.deps.onChanged();
  }

  private isChannelDescendant(channelId: number, ancestorId: number): boolean {
    const seen = new Set<number>();
    let current = this.channels.get(channelId);
    while (current && !seen.has(current.info.id)) {
      if (current.info.id === ancestorId) return true;
      seen.add(current.info.id);
      if (current.info.parentId === NO_CHANNEL) break;
      current = this.channels.get(current.info.parentId);
    }
    return false;
  }

  // --------------------------------------------------------------- claims --

  private claimResp(s: Session, respawn: string, note: string): void {
    const preset = this.activePreset();
    if (preset.respawns.length === 0) {
      return this.fail(s, FailureCode.NotPermitted, 'este preset nao usa claims de respawn');
    }
    const name = canonicalRespawnIn(preset, clean(respawn, 96));
    if (!name) return this.fail(s, FailureCode.Malformed, 'respawn invalido');
    this.pruneClaims();
    const key = name.toLowerCase();
    for (const claim of this.claims.values()) {
      if (claim.ownerFingerprint === s.fingerprint) {
        return this.fail(
          s,
          FailureCode.NotPermitted,
          `voce ja tem ${claim.respawn} claimado; libere antes de pegar outro`,
        );
      }
      if (claim.respawn.toLowerCase() === key) {
        return this.fail(s, FailureCode.NotPermitted, `${claim.respawn} ja esta claimado por ${claim.ownerName}`);
      }
    }

    const now = Date.now();
    const claim: StoredRespClaim = {
      id: this.allocClaimId(),
      respawn: name,
      note: clean(note, 160),
      ownerName: s.nickname,
      ownerFingerprint: s.fingerprint,
      claimedAt: now,
      // Claims de respawn têm duração fixa: a regra também precisa valer para
      // clientes antigos ou modificados que ainda enviem outro valor.
      expiresAt: now + 3 * 60 * 60 * 1000,
      queue: [],
    };
    this.claims.set(claim.id, claim);
    this.deps.onChanged();
    this.broadcastClaims();
    this.announce(`${s.nickname} claimou ${claim.respawn}`);
  }

  private releaseResp(s: Session, claimId: number): void {
    const claim = this.claims.get(claimId);
    if (!claim) return this.fail(s, FailureCode.Unknown, 'claim inexistente');
    if (claim.ownerFingerprint !== s.fingerprint && s.group < Group.Moderator) {
      return this.fail(s, FailureCode.NotPermitted, 'apenas quem claimou ou moderador pode liberar');
    }
    const next = claim.queue.shift();
    if (next) {
      const now = Date.now();
      claim.ownerFingerprint = next.fingerprint;
      claim.ownerName = this.liveNameForFingerprint(next.fingerprint) || next.name;
      claim.claimedAt = now;
      claim.expiresAt = now + 3 * 60 * 60 * 1000;
      this.announce(`${claim.ownerName} assumiu ${claim.respawn}`);
    } else {
      this.claims.delete(claimId);
      this.announce(`${s.nickname} liberou ${claim.respawn}`);
    }
    this.deps.onChanged();
    this.broadcastClaims();
  }

  private joinRespQueue(s: Session, claimId: number): void {
    const claim = this.claims.get(claimId);
    if (!claim) return this.fail(s, FailureCode.Unknown, 'claim inexistente');
    if (claim.ownerFingerprint === s.fingerprint) {
      return this.fail(s, FailureCode.NotPermitted, 'voce ja esta neste respawn');
    }
    if (claim.queue.some((q) => q.fingerprint === s.fingerprint)) return;
    claim.queue.push({ name: s.nickname, fingerprint: s.fingerprint });
    this.deps.onChanged();
    this.broadcastClaims();
    this.announce(`${s.nickname} entrou na fila de ${claim.respawn}`);
  }

  private leaveRespQueue(s: Session, claimId: number): void {
    const claim = this.claims.get(claimId);
    if (!claim) return this.fail(s, FailureCode.Unknown, 'claim inexistente');
    const before = claim.queue.length;
    claim.queue = claim.queue.filter((q) => q.fingerprint !== s.fingerprint);
    if (claim.queue.length === before) return;
    this.deps.onChanged();
    this.broadcastClaims();
  }

  private allocClaimId(): number {
    for (let i = 1; i < 0xffff; i++) {
      if (!this.claims.has(i)) return i;
    }
    return Math.floor(Math.random() * 0xffff) || 1;
  }

  private pruneClaims(now = Date.now()): boolean {
    let changed = false;
    for (const [id, claim] of this.claims) {
      if (claim.expiresAt <= now) {
        this.claims.delete(id);
        changed = true;
      }
    }
    if (changed) this.deps.onChanged();
    return changed;
  }

  private clientIdForFingerprint(fingerprint: string): number {
    for (const s of this.sessions.values()) {
      if (s.fingerprint === fingerprint) return s.id;
    }
    return 0;
  }

  private liveNameForFingerprint(fingerprint: string): string {
    for (const s of this.sessions.values()) {
      if (s.fingerprint === fingerprint) return s.nickname;
    }
    return '';
  }

  private broadcastClaims(): void {
    this.broadcast({ t: Op.RespClaims, claims: this.claimList() });
  }

  // --------------------------------------------------------------- bot state --

  private botState(): BotStateInfo {
    const c = this.botConfig;
    return {
      world: c.world,
      guildName: c.guildName,
      channelName: c.channelName,
      intervalMs: c.intervalMs,
      enabled: c.enabled,
      globalDeaths: c.globalDeaths,
      globalKills: c.globalKills,
      globalLevelMin: c.globalLevelMin,
      summarizePresence: c.summarizePresence,
      presenceSummaryMs: c.presenceSummaryMs,
      alertEnemyDeath: c.alertEnemyDeath,
      alertFriendDeath: c.alertFriendDeath,
      alertFriendLevelUp: c.alertFriendLevelUp,
      alertEnemyLevelUp: c.alertEnemyLevelUp,
      alertEnemyOnline: c.alertEnemyOnline,
      alertEnemyOffline: c.alertEnemyOffline,
      running: this.rubinot?.isRunning ?? false,
      starting: this.rubinot?.isStarting ?? false,
      error: this.rubinot?.lastStartError ?? '',
      hunted: this.rubinot?.manualHuntedList ?? [...c.huntedNames],
      friends: this.rubinot?.friendsList ?? [],
      friendGuilds: [...c.friendGuilds],
      enemyGuilds: [...c.enemyGuilds],
    };
  }

  broadcastBotState(): void {
    const frame = encodeServerMessage({ t: Op.BotState, state: this.botState() });
    for (const s of this.sessions.values()) {
      if (s.group >= Group.Dono) s.send(frame);
    }
  }

  private applyBotControl(s: Session, action: BotControlAction, name: string): void {
    switch (action) {
      case BotControlAction.Start:
        {
          const error = startBot(this);
          if (error) return this.sendBotResult(s, false, error);
        }
        this.deps.onChanged();
        break;
      case BotControlAction.Stop:
        stopBot(this);
        this.deps.onChanged();
        break;
      case BotControlAction.Test:
        testBot(this);
        break;
      case BotControlAction.AddHunted: {
        const trimmed = clean(name, 32);
        if (!trimmed) return this.fail(s, FailureCode.Malformed, 'nome vazio');
        if (this.rubinot) {
          this.rubinot.addHunted(trimmed);
        } else if (!this.botConfig.huntedNames.some((n) => n.toLowerCase() === trimmed.toLowerCase())) {
          this.botConfig.huntedNames.push(trimmed);
        }
        this.deps.onChanged();
        break;
      }
      case BotControlAction.RemoveHunted: {
        const trimmed = clean(name, 32);
        if (!trimmed) return this.fail(s, FailureCode.Malformed, 'nome vazio');
        if (this.rubinot) {
          this.rubinot.removeHunted(trimmed);
        } else {
          this.botConfig.huntedNames = this.botConfig.huntedNames.filter(
            (n) => n.toLowerCase() !== trimmed.toLowerCase(),
          );
        }
        this.deps.onChanged();
        break;
      }
      case BotControlAction.AddFriendGuild:
      case BotControlAction.AddEnemyGuild: {
        const trimmed = clean(name, 64);
        if (!trimmed) return this.fail(s, FailureCode.Malformed, 'nome vazio');
        const key = trimmed.toLowerCase();
        const isFriend = action === BotControlAction.AddFriendGuild;
        // Uma guild so pode estar em uma lista de cada vez: adicionar em uma
        // remove da outra, para nao ficar sync ambigua com "amigo ganha".
        const opposite = isFriend ? this.botConfig.enemyGuilds : this.botConfig.friendGuilds;
        const oppositeBefore = opposite.length;
        const filtered = opposite.filter((g) => g.toLowerCase() !== key);
        if (isFriend) this.botConfig.enemyGuilds = filtered;
        else this.botConfig.friendGuilds = filtered;

        const list = isFriend ? this.botConfig.friendGuilds : this.botConfig.enemyGuilds;
        let mutated = filtered.length !== oppositeBefore;
        if (!list.some((g) => g.toLowerCase() === key)) {
          list.push(trimmed);
          mutated = true;
        }
        if (mutated) {
          this.deps.onChanged();
          void applyBotConfig(this).catch((err) => console.error('[bot] falha ao aplicar configuração:', err));
        }
        break;
      }
      case BotControlAction.RemoveFriendGuild:
      case BotControlAction.RemoveEnemyGuild: {
        const trimmed = clean(name, 64);
        if (!trimmed) return this.fail(s, FailureCode.Malformed, 'nome vazio');
        if (action === BotControlAction.RemoveFriendGuild) {
          this.botConfig.friendGuilds = this.botConfig.friendGuilds.filter(
            (g) => g.toLowerCase() !== trimmed.toLowerCase(),
          );
        } else {
          this.botConfig.enemyGuilds = this.botConfig.enemyGuilds.filter(
            (g) => g.toLowerCase() !== trimmed.toLowerCase(),
          );
        }
        this.deps.onChanged();
        void applyBotConfig(this).catch((err) => console.error('[bot] falha ao aplicar configuração:', err));
        break;
      }
      default:
        return this.fail(s, FailureCode.Malformed, 'acao desconhecida');
    }
    this.broadcastBotState();
  }

  // ----------------------------------------------------------------- chat --

  private routeChat(s: Session, scope: ChatScope, targetId: number, text: string): void {
    const body = clean(text, MAX_CHAT_TEXT);
    if (!body) return;

    // Mensagens de canal sempre pertencem ao canal em que o remetente esta.
    // O targetId enviado pelo cliente e ignorado nesse escopo: assim cada
    // conversa pode ser filtrada corretamente no historico do cliente.
    const routedTargetId = scope === ChatScope.Channel ? s.channelId : targetId;

    const frame = encodeServerMessage({
      t: Op.ChatDeliver,
      scope,
      senderId: s.id,
      targetId: routedTargetId,
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

  private routeScreenSignal(s: Session, targetId: number, kind: string, data: string): void {
    const signalKind = clean(kind, 24);
    if (!signalKind || data.length > MAX_SCREEN_SIGNAL) return;

    const frame = encodeServerMessage({
      t: Op.ScreenSignalDeliver,
      senderId: s.id,
      targetId,
      kind: signalKind,
      data,
    });

    if (targetId > 0) {
      const target = this.sessions.get(targetId);
      if (!target || target.channelId !== s.channelId) return;
      target.send(frame);
      return;
    }

    const ch = this.channels.get(s.channelId);
    if (!ch) return;
    for (const member of ch.members) {
      if (member !== s) member.send(frame);
    }
  }

  // -------------------------------------------------------- bot commands --

  private handleBotCommand(s: Session, command: string, args: string[]): void {
    const cmd = command.toLowerCase();
    const minGroup = this.getRequiredGroupForBotCommand(cmd, args);

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
        // Push do bot e uma movimentacao autorizada, portanto tambem pode
        // puxar Spy (que nao pode trocar de canal por conta propria).
        this.forceMove(target, destChannel.info.id);
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
        let protectedCount = 0;
        for (const m of sources) {
          if (m.id === s.id || m.channelId === destChannel.info.id) continue;
          if (this.isServiceSession(m)) {
            protectedCount++;
            continue;
          }
          if (!this.canEnter(m, destChannel)) continue;
          this.forceMove(m, destChannel.info.id);
          count++;
        }
        const protectedNote = protectedCount > 0 ? `; ${protectedCount} bot(s)/player(s) preservado(s)` : '';
        this.sendBotResult(s, true, `${count} usuarios movidos para ${destChannel.info.name}${protectedNote}`);
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
        this.syncVoiceState(target);
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
        this.syncVoiceState(target);
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
              this.syncVoiceState(m);
              this.broadcast({ t: Op.ClientState, clientId: m.id, flags: m.flags });
            }
          }
        } else {
          channel.info.flags |= ChannelFlags.Moderated;
        }
        for (const m of channel.members) this.syncVoiceState(m);
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
        this.syncVoiceState(target);
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
        this.syncVoiceState(target);
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
        if (s.group >= Group.Dono) {
          return this.sendBotResult(s, false, 'voce ja e dono.');
        }
        this.assignGroup(s, Group.Dono);
        this.sendBotResult(s, true, 'voce agora e dono do servidor.');
        console.log(`[vox] servidor ${this.settings.id}: ${s.fingerprint.slice(0, 12)} virou dono via /owner`);
        break;
      }
      case 'hunt':
      case 'unhunt':
      case 'hunted': {
        if (!this.rubinot) return this.sendBotResult(s, false, 'bot nao esta ativo');
        const requestedSubcommand = cmd === 'hunt' ? 'add' : cmd === 'unhunt' ? 'remove' : (args[0]?.toLowerCase() ?? 'list');
        const subcommand = requestedSubcommand === 'del' || requestedSubcommand === 'delete'
          ? 'remove'
          : requestedSubcommand;
        if (subcommand === 'add' || subcommand === 'remove') {
          const nameArgs = cmd === 'hunted' ? args.slice(1) : args;
          if (nameArgs.length < 1) return this.sendBotResult(s, false, 'uso: hunted add <nome> ou hunted remove <nome>');
          const name = nameArgs.join(' ');
          if (subcommand === 'add') this.rubinot.addHunted(name);
          else this.rubinot.removeHunted(name);
          this.sendBotResult(s, true, `${name} ${subcommand === 'add' ? 'adicionado a' : 'removido da'} hunted list`);
          break;
        }
        if (cmd === 'hunted' && subcommand !== 'list') {
          return this.sendBotResult(s, false, 'uso: hunted [list] ou hunted add/remove <nome>');
        }
        const list = this.rubinot.huntedList;
        if (list.length === 0) return this.sendBotResult(s, true, 'hunted list vazia');
        this.sendBotResult(s, true, `hunted list (${list.length}):\n${list.join('\n')}`);
        break;
      }
      default:
        this.sendBotResult(s, false, `comando desconhecido: ${command}`);
    }
  }

  private getRequiredGroupForBotCommand(cmd: string, args: string[] = []): Group {
    const map: Record<string, PermissionAction> = {
      poke: PermissionAction.BotPoke,
      masspoke: PermissionAction.BotMassPoke,
      push: PermissionAction.BotPush,
      masspush: PermissionAction.BotMassPush,
      kick: PermissionAction.BotKick,
      masskick: PermissionAction.BotMassKick,
      ban: PermissionAction.BotBan,
      banlist: PermissionAction.BotBanList,
      unban: PermissionAction.BotUnban,
      afk: PermissionAction.BotAfk,
      mute: PermissionAction.BotMute,
      unmute: PermissionAction.BotUnmute,
      moderate: PermissionAction.BotModerate,
      voice: PermissionAction.BotVoice,
      devoice: PermissionAction.BotDevoice,
      hunt: PermissionAction.BotHunt,
      unhunt: PermissionAction.BotUnhunt,
      hunted: PermissionAction.BotHunted,
    };
    // /owner e caso especial: qualquer um pode digitar (a senha e que autoriza).
    if (cmd === 'owner') return Group.Guest;
    // Estes comandos alteram o estado/configuracao do bot; nao sao comandos
    // de moderacao e, portanto, nao seguem a matriz operacional abaixo.
    if (cmd === 'afk' || cmd === 'hunt' || cmd === 'unhunt') return Group.Dono;
    if (cmd === 'hunted' && ['add', 'remove', 'del', 'delete'].includes((args[0] ?? '').toLowerCase())) {
      return Group.Dono;
    }
    const action = map[cmd];
    return action !== undefined ? this.permissionFor(action) : Group.Dono;
  }

  private findClientByNick(nick: string): Session | undefined {
    const lower = nick.toLowerCase();
    for (const s of this.sessions.values()) {
      if (s.nickname.toLowerCase() === lower) return s;
    }
    return undefined;
  }

  /** Sessões automatizadas não devem ser arrastadas pelo masspush. */
  private isServiceSession(session: Session): boolean {
    const platform = session.platform.trim().toLowerCase();
    const nickname = session.nickname.trim().toLowerCase();
    return platform.includes('bot')
      || platform.includes('jukebox')
      || /^(?:music(?: player)?|rubinot)$/.test(nickname);
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

  /** Envia mensagem de bot para um canal especifico. */
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
    for (const m of ch.members) m.send(frame);
  }

  /** Envia alerta de bot para quem esta fora do canal de log. */
  serverChannelAnnounce(channelId: number, sender: string, text: string): void {
    if (!this.channels.has(channelId)) return;
    const frame = encodeServerMessage({
      t: Op.ChatDeliver,
      scope: ChatScope.Channel,
      senderId: 0,
      targetId: channelId,
      senderName: sender,
      text,
      stamp: Date.now(),
    });
    for (const s of this.sessions.values()) {
      if (s.channelId !== channelId && this.canViewChannels(s)) s.send(frame);
    }
  }

  /** Encontra canal pelo nome (primeiro match, case-insensitive). */
  findChannelByName(name: string, parentId: number | null = null): number | undefined {
    const lower = name.toLowerCase();
    for (const [id, ch] of this.channels) {
      if (ch.info.name.toLowerCase() !== lower) continue;
      if (parentId !== null && ch.info.parentId !== parentId) continue;
      return id;
    }
    return undefined;
  }

  /**
   * Garante que um canal com o nome dado exista. Se nao existir, cria um canal
   * permanente na raiz (para o bot postar notificacoes).
   */
  ensureChannel(name: string, parentId = NO_CHANNEL): number {
    const existing = this.findChannelByName(name, parentId);
    if (existing !== undefined) return existing;
    const label = clean(name, 64) || 'bot';
    const info: ChannelInfo = {
      id: this.allocChannelId(),
      parentId,
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

  /** Atualiza a descrição de um canal gerenciado internamente pelo bot. */
  setChannelTopic(channelId: number, topic: string): void {
    const ch = this.channels.get(channelId);
    if (!ch) return;
    const next = cleanMultilineTopic(topic, 12_000);
    if (ch.info.topic === next) return;
    ch.info.topic = next;
    this.broadcast({ t: Op.ChannelUpdate, channel: ch.info });
    this.deps.onChanged();
  }

  /** Avisa uma mudanca de canal sem expor a arvore inteira a sessoes restritas. */
  private broadcastClientMove(target: Session, previousChannelId: number, channelId: number): void {
    const moveFrame = encodeServerMessage({ t: Op.ClientMove, clientId: target.id, channelId });
    const removeFrame = encodeServerMessage({
      t: Op.ClientRemove,
      clientId: target.id,
      // Para quem estava no canal anterior, sair da visao e semanticamente
      // igual a uma remocao. O motivo nao e exibido ao usuario.
      reason: RemoveReason.Disconnected,
    });
    const addFrame = encodeServerMessage({ t: Op.ClientAdd, client: this.describe(target) });

    for (const observer of this.sessions.values()) {
      if (observer === target || this.canViewChannels(observer)) {
        observer.send(moveFrame);
      } else if (previousChannelId !== NO_CHANNEL && observer.channelId === previousChannelId) {
        observer.send(removeFrame);
      } else if (channelId !== NO_CHANNEL && observer.channelId === channelId) {
        observer.send(addFrame);
      }
    }
  }

  /** Remove apenas quem podia ver o cliente no canal em que ele estava. */
  private broadcastClientRemove(target: Session, previousChannelId: number, reason: RemoveReason): void {
    const frame = encodeServerMessage({ t: Op.ClientRemove, clientId: target.id, reason });
    for (const observer of this.sessions.values()) {
      if (this.canViewChannels(observer)
        || (previousChannelId !== NO_CHANNEL && observer.channelId === previousChannelId)) {
        observer.send(frame);
      }
    }
  }

  private broadcast(m: ServerMessage, except?: Session): void {
    const frame = encodeServerMessage(m);
    for (const s of this.sessions.values()) {
      if (s === except) continue;
      // Sessoes com visao completa recebem o evento original. Sessoes
      // restritas recebem apenas eventos de clientes do proprio canal; mudanca
      // estrutural continua usando Snapshot, mas com debounce.
      if (!this.canViewChannels(s) && this.isChannelVisibilityMessage(m)) {
        this.broadcastRestrictedVisibility(s, m, frame);
      } else {
        s.send(frame);
      }
    }
  }

  private broadcastRestrictedVisibility(s: Session, m: ServerMessage, frame: Uint8Array): void {
    switch (m.t) {
      case Op.ClientAdd:
        if (m.client.id === s.id || (s.channelId !== NO_CHANNEL && m.client.channelId === s.channelId)) {
          s.send(frame);
        }
        return;
      case Op.ClientState: {
        if (m.clientId === s.id) {
          s.send(frame);
          return;
        }
        const peer = this.sessions.get(m.clientId);
        if (peer && s.channelId !== NO_CHANNEL && peer.channelId === s.channelId) s.send(frame);
        return;
      }
      case Op.ClientMove:
      case Op.ClientRemove:
        // Os caminhos normais usam broadcastClientMove/Remove, que conhecem
        // o canal anterior. Este fallback mantém consistencia para chamadas
        // futuras que adicionem um evento direto.
        this.scheduleVisibilitySnapshot(s);
        return;
      default:
        this.scheduleVisibilitySnapshot(s);
    }
  }

  private isChannelVisibilityMessage(m: ServerMessage): boolean {
    return m.t === Op.Snapshot
      || m.t === Op.ChannelAdd
      || m.t === Op.ChannelRemove
      || m.t === Op.ChannelUpdate
      || m.t === Op.ClientAdd
      || m.t === Op.ClientRemove
      || m.t === Op.ClientMove
      || m.t === Op.ClientState;
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

/** Pequeno semaforo async, sem bloquear o event loop enquanto aguarda vaga. */
class AsyncGate {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

/** Extrai "<nome>" de "Main: <nome>" na descricao. Vazio se nao ha main. */
function extractMain(desc: string): string {
  const m = /main\s*:\s*(.+)/i.exec(desc);
  return (m?.[1] || '').trim().toLowerCase();
}

const PROFILE_BORDERS = new Set<ProfileBorder>(['none', 'ember', 'royal', 'signal', 'frost']);

function validProfileBorder(value: string): ProfileBorder {
  return PROFILE_BORDERS.has(value as ProfileBorder) ? value as ProfileBorder : 'none';
}

function validProfileAvatar(value: string): boolean {
  if (!value) return true;
  if (value.length > 40 * 1024) return false;
  return /^data:image\/(?:webp|jpeg|png);base64,[a-z0-9+/=]+$/i.test(value);
}

/** Limpa descrição de relatório sem destruir as quebras de linha do bot. */
function cleanMultilineTopic(value: string, max: number): string {
  let out = '';
  for (const ch of value) {
    if (ch === '\n') {
      out += ch;
      continue;
    }
    const c = ch.codePointAt(0)!;
    const junk =
      c < 0x20 ||
      (c >= 0x7f && c <= 0x9f) ||
      c === 0xad ||
      (c >= 0x200b && c <= 0x200f) ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0x2060 ||
      c === 0xfeff;
    if (!junk) out += ch;
  }
  return out.trim().slice(0, max);
}
