import {
  Room,
  RoomEvent,
  Track,
  createLocalScreenTracks,
} from 'livekit-client';
import type { LocalTrack, RemoteTrack } from 'livekit-client';
import { Op } from '@vox/protocol';
import type { ClientInfo, ClientMessage } from '@vox/protocol';

export interface LiveKitCredentials {
  url: string;
  token: string;
  room: string;
}

export interface RemoteScreen {
  clientId: number;
  stream: MediaStream;
  track: RemoteTrack;
}

export interface ScreenPeerProvider {
  selfId(): number;
  selfChannelId(): number;
  membersOf(channelId: number): ClientInfo[];
  requestLiveKitToken(channelId: number): Promise<LiveKitCredentials>;
}

/** Injetável para cobrir corridas de conexão sem capturar uma tela real. */
export interface ScreenRuntime {
  createRoom(): Room;
  capture(): Promise<LocalTrack[]>;
  stream(track: MediaStreamTrack): MediaStream;
}

const defaultRuntime: ScreenRuntime = {
  createRoom: () => new Room({ adaptiveStream: true, dynacast: true }),
  capture: () => createLocalScreenTracks({
    audio: false,
    resolution: { width: 1280, height: 720, frameRate: 15 },
    contentHint: 'detail',
  }),
  stream: (track) => new MediaStream([track]),
};

/**
 * Compartilhamento via SFU: o navegador publica uma vez e o LiveKit entrega
 * a tela aos espectadores. O socket Vox continua reservado para controle e
 * voz, então uma tela pesada não cria uma conexão P2P por pessoa.
 * A presença é anunciada pelo Vox; vídeo só é assinado após clicar em assistir.
 */
export class ScreenShare {
  readonly live = new Set<number>();
  readonly watching = new Set<number>();
  readonly remotes = new Map<number, RemoteScreen>();
  localStream: MediaStream | null = null;
  error = '';
  starting = false;

  private readonly audience = new Map<number, Set<number>>();
  private readonly playing = new Set<number>();
  private readonly visible = new Set<number>();
  private readonly watchTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private room: Room | null = null;
  private roomChannelId = 0;
  private connectingRoom: Promise<Room> | null = null;
  private localTrack: LocalTrack | null = null;
  private generation = 0;
  private captureGeneration = 0;
  private lastAudience = '[]';

  constructor(
    private readonly provider: ScreenPeerProvider,
    private readonly send: (m: ClientMessage) => void,
    private readonly onChange: () => void,
    private readonly media: ScreenRuntime = defaultRuntime,
  ) {}

  get sharing(): boolean {
    return this.localStream !== null;
  }

  isLive(clientId: number): boolean {
    return clientId === this.provider.selfId() ? this.sharing : this.live.has(clientId);
  }

  viewersOf(clientId: number): ClientInfo[] {
    if (!this.isLive(clientId)) return [];
    return this.provider.membersOf(this.provider.selfChannelId()).filter((member) =>
      member.id !== clientId && this.audience.get(member.id)?.has(clientId));
  }

  async toggle(): Promise<void> {
    if (this.localStream || this.starting) {
      this.stop();
      return;
    }
    await this.start();
  }

  async start(): Promise<void> {
    if (this.sharing || this.starting) return;
    this.error = '';
    const channelId = this.provider.selfChannelId();
    if (channelId <= 0) {
      this.error = 'entre em um canal antes de compartilhar a tela';
      this.onChange();
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.error = 'compartilhamento de tela indisponivel neste navegador';
      this.onChange();
      return;
    }

    const capture = ++this.captureGeneration;
    this.starting = true;
    this.onChange();
    let track: LocalTrack | null = null;
    try {
      const room = await this.ensureRoom(channelId);
      if (capture !== this.captureGeneration) return;
      const tracks = await this.media.capture();
      track = tracks.find((candidate) => candidate.kind === Track.Kind.Video) ?? null;
      for (const extra of tracks) if (extra !== track) extra.stop();
      if (!track) throw new Error('nenhuma faixa de video foi capturada');

      if (capture !== this.captureGeneration || this.room !== room) {
        track.stop();
        return;
      }
      await room.localParticipant.publishTrack(track, this.publishOptions());
      if (capture !== this.captureGeneration || this.room !== room || this.roomChannelId !== channelId) {
        await room.localParticipant.unpublishTrack(track).catch(() => {});
        track.stop();
        return;
      }
      this.localTrack = track;
      this.localStream = this.media.stream(track.mediaStreamTrack);
      track.mediaStreamTrack.addEventListener('ended', () => {
        if (this.localTrack === track) this.stop();
      }, { once: true });
      this.signal(0, 'livekit-start');
    } catch (err) {
      track?.stop();
      if (capture === this.captureGeneration) this.error = describeScreenError(err);
    } finally {
      if (capture === this.captureGeneration) {
        this.starting = false;
        this.disconnectIfIdle();
        this.onChange();
      }
    }
  }

  async watch(clientId: number): Promise<void> {
    if (!this.live.has(clientId) || !this.isPeer(clientId) || this.watching.has(clientId)) return;
    this.error = '';
    this.watching.add(clientId);
    this.watchTimers.set(clientId, setTimeout(() => {
      this.error = 'A transmissão não respondeu. Feche e tente assistir novamente.';
      this.stopWatching(clientId);
    }, 20_000));
    this.onChange();
    const channelId = this.provider.selfChannelId();
    try {
      const room = await this.ensureRoom(channelId);
      if (this.room !== room || !this.watching.has(clientId)) return;
      this.syncSubscriptions();
    } catch (err) {
      if (this.provider.selfChannelId() !== channelId || !this.watching.has(clientId)) return;
      this.error = describeScreenError(err);
      this.stopWatching(clientId);
    }
  }

  stopWatching(clientId: number): void {
    this.watching.delete(clientId);
    this.visible.delete(clientId);
    this.clearWatchTimer(clientId);
    this.dropRemote(clientId);
    this.syncSubscriptions();
    this.disconnectIfIdle();
    this.onChange();
  }

  /** Só telas visíveis ficam assinadas e contam como espectadores. */
  setVisibleScreens(clientIds: readonly number[]): void {
    const next = new Set(clientIds.filter((id) => this.watching.has(id)));
    if (next.size === this.visible.size && [...next].every((id) => this.visible.has(id))) return;
    this.visible.clear();
    for (const id of next) this.visible.add(id);
    for (const id of this.playing) if (!next.has(id)) this.playing.delete(id);
    this.announceWatching();
    this.syncSubscriptions();
  }

  /** Chamado pelo evento playing do vídeo, não pela entrada no canal. */
  markPlaying(clientId: number, stream: MediaStream): void {
    if (!this.visible.has(clientId) || this.remotes.get(clientId)?.stream !== stream || this.playing.has(clientId)) return;
    this.clearWatchTimer(clientId);
    this.playing.add(clientId);
    this.announceWatching();
    this.onChange();
  }

  syncPresence(): void {
    this.signal(0, 'livekit-sync');
  }

  /** Anuncia a tela para uma pessoa que acabou de chegar no canal. */
  onPeerReachable(clientId: number): void {
    if (!this.isPeer(clientId)) return;
    if (this.sharing) this.signal(clientId, 'livekit-start');
    this.signal(clientId, 'livekit-watching', this.lastAudience);
  }

  onPeerLeft(clientId: number): void {
    this.audience.delete(clientId);
    this.endBroadcast(clientId);
  }

  /** Troca a sala SFU quando o usuario muda de canal. */
  onSelfMoved(): void {
    ++this.captureGeneration;
    this.starting = false;
    const channelId = this.provider.selfChannelId();
    const local = this.localTrack;
    this.clearPresence();
    this.disconnectRoom();
    if (local && channelId > 0) {
      void this.republishAfterMove(local, channelId);
    } else if (local) this.stop();
    this.syncPresence();
    this.onChange();
  }

  stop(): void {
    ++this.captureGeneration;
    this.starting = false;
    const local = this.localTrack;
    const room = this.room;
    this.localTrack = null;
    this.localStream = null;
    if (local) {
      if (room) void room.localParticipant.unpublishTrack(local, false).catch(() => {});
      local.stop();
      this.signal(0, 'livekit-stop');
    }
    this.announceWatching();
    this.disconnectIfIdle();
    this.onChange();
  }

  close(): void {
    this.stop();
    this.clearPresence();
    this.disconnectRoom();
    this.error = '';
  }

  /** Recebe apenas os pequenos eventos de presença pelo controle Vox. */
  async handleSignal(senderId: number, targetId: number, kind: string, data: string): Promise<void> {
    if (targetId > 0 && targetId !== this.provider.selfId()) return;
    if (!this.isPeer(senderId)) return;

    if (kind === 'livekit-start') {
      if (!this.live.has(senderId)) {
        this.live.add(senderId);
        this.onChange();
      }
    } else if (kind === 'livekit-stop') {
      this.endBroadcast(senderId);
    } else if (kind === 'livekit-sync') {
      this.onPeerReachable(senderId);
    } else if (kind === 'livekit-watching') {
      // Um cliente só pode informar a própria presença, nunca a de terceiros.
      if (data.length > 4096) return;
      try {
        const ids: unknown = JSON.parse(data);
        if (!Array.isArray(ids) || ids.length > 128) return;
        const members = new Set(this.provider.membersOf(this.provider.selfChannelId()).map((member) => member.id));
        const valid = ids.filter((id): id is number => Number.isInteger(id) && id !== senderId && members.has(id));
        this.audience.set(senderId, new Set(valid));
        this.onChange();
      } catch {
        // Controle inválido não interfere na voz ou no vídeo.
      }
    }
  }

  private async ensureRoom(channelId: number): Promise<Room> {
    if (this.roomChannelId === channelId && this.connectingRoom) return this.connectingRoom;
    if (this.room && this.roomChannelId === channelId) return this.room;

    const generation = this.generation;
    this.roomChannelId = channelId;
    const promise = (async () => {
      const access = await this.provider.requestLiveKitToken(channelId);
      if (generation !== this.generation || channelId !== this.provider.selfChannelId()) throw new Error('conexão de tela cancelada');
      const room = this.media.createRoom();
      this.room = room;
      this.bindRoom(room);
      try {
        await room.connect(access.url, access.token, { autoSubscribe: false });
        if (this.room !== room) throw new Error('conexão de tela cancelada');
        this.syncSubscriptions();
        return room;
      } catch (err) {
        if (this.room === room) {
          this.room = null;
          this.roomChannelId = 0;
        }
        await room.disconnect(false).catch(() => {});
        throw err;
      }
    })();
    this.connectingRoom = promise;
    try {
      return await promise;
    } finally {
      if (this.connectingRoom === promise) this.connectingRoom = null;
    }
  }

  private bindRoom(room: Room): void {
    room.on(RoomEvent.TrackPublished, () => {
      if (this.room === room) this.syncSubscriptions();
    });
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      const clientId = identityToClientId(participant.identity);
      if (this.room !== room || publication.source !== Track.Source.ScreenShare || !this.watching.has(clientId)
        || !this.visible.has(clientId) || !this.isPeer(clientId)) return;
      this.addRemote(track, clientId);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
      if (track.kind === Track.Kind.Video) {
        const clientId = identityToClientId(participant.identity);
        if (this.remotes.get(clientId)?.track === track) {
          this.dropRemote(clientId);
          this.onChange();
        }
      }
    });
    room.on(RoomEvent.TrackUnpublished, (publication, participant) => {
      if (publication.source === Track.Source.ScreenShare) this.endBroadcast(identityToClientId(participant.identity));
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (this.room === room) this.onPeerLeft(identityToClientId(participant.identity));
    });
    room.on(RoomEvent.Reconnecting, () => {
      if (this.room !== room) return;
      for (const clientId of this.remotes.keys()) this.dropRemote(clientId);
      this.onChange();
    });
    room.on(RoomEvent.Reconnected, () => {
      if (this.room !== room) return;
      this.syncSubscriptions();
      if (this.sharing) this.signal(0, 'livekit-start');
      this.syncPresence();
      this.onChange();
    });
    room.on(RoomEvent.TrackSubscriptionFailed, (_sid, participant) => {
      if (this.room !== room) return;
      const clientId = identityToClientId(participant.identity);
      if (!this.watching.has(clientId)) return;
      this.error = 'Não foi possível receber a transmissão. Tente assistir novamente.';
      this.stopWatching(clientId);
    });
    room.on(RoomEvent.Disconnected, () => {
      if (this.room !== room) return;
      this.error = 'A conexão da transmissão caiu. Tente abrir ou compartilhar novamente.';
      this.stop();
      for (const clientId of [...this.watching]) this.stopWatching(clientId);
      this.disconnectRoom();
      this.onChange();
    });
  }

  private syncSubscriptions(): void {
    if (!this.room) return;
    for (const participant of this.room.remoteParticipants.values()) {
      const clientId = identityToClientId(participant.identity);
      for (const publication of participant.trackPublications.values()) {
        if (publication.source !== Track.Source.ScreenShare || !this.isPeer(clientId)) continue;
        this.live.add(clientId);
        const desired = this.watching.has(clientId) && this.visible.has(clientId);
        if (publication.isDesired !== desired) publication.setSubscribed(desired);
        // Após uma reconexão, a faixa pode estar pronta sem novo evento.
        if (desired && publication.track && !this.remotes.has(clientId)) {
          this.addRemote(publication.track as RemoteTrack, clientId);
        }
      }
    }
  }

  private addRemote(track: RemoteTrack, clientId: number): void {
    if (track.kind !== Track.Kind.Video || clientId <= 0 || clientId === this.provider.selfId()) return;
    this.remotes.set(clientId, {
      clientId,
      stream: this.media.stream(track.mediaStreamTrack),
      track,
    });
    this.onChange();
  }

  private dropRemote(clientId: number): void {
    const remote = this.remotes.get(clientId);
    if (!remote) return;
    remote.track.detach();
    this.remotes.delete(clientId);
    this.playing.delete(clientId);
    this.announceWatching();
  }

  private endBroadcast(clientId: number): void {
    this.live.delete(clientId);
    for (const ids of this.audience.values()) ids.delete(clientId);
    this.stopWatching(clientId);
  }

  private announceWatching(): void {
    const ids = [...this.playing]
      .filter((clientId) => this.visible.has(clientId) && this.watching.has(clientId))
      .sort((a, b) => a - b);
    const data = JSON.stringify(ids);
    this.audience.set(this.provider.selfId(), new Set(ids));
    if (this.lastAudience === data) return;
    this.lastAudience = data;
    this.signal(0, 'livekit-watching', data);
  }

  private clearWatchTimer(clientId: number): void {
    clearTimeout(this.watchTimers.get(clientId));
    this.watchTimers.delete(clientId);
  }

  private clearPresence(): void {
    for (const clientId of this.watchTimers.keys()) this.clearWatchTimer(clientId);
    for (const remote of this.remotes.values()) remote.track.detach();
    this.live.clear();
    this.watching.clear();
    this.visible.clear();
    this.playing.clear();
    this.remotes.clear();
    this.audience.clear();
    this.lastAudience = '[]';
  }

  private async republishAfterMove(local: LocalTrack, channelId: number): Promise<void> {
    try {
      const room = await this.ensureRoom(channelId);
      if (this.localTrack !== local || this.room !== room) return;
      await room.localParticipant.publishTrack(local, this.publishOptions());
      if (this.localTrack !== local || this.room !== room) return;
      this.signal(0, 'livekit-start');
      this.onChange();
    } catch (err) {
      if (this.localTrack !== local || this.provider.selfChannelId() !== channelId) return;
      this.error = describeScreenError(err);
      this.stop();
    }
  }

  private publishOptions() {
    return {
      source: Track.Source.ScreenShare,
      name: 'screen',
      screenShareEncoding: { maxBitrate: 1_200_000, maxFramerate: 15 },
      simulcast: false,
      degradationPreference: 'maintain-resolution' as RTCDegradationPreference,
    };
  }

  private disconnectRoom(): void {
    const room = this.room;
    this.room = null;
    this.roomChannelId = 0;
    this.connectingRoom = null;
    ++this.generation;
    if (room) void room.disconnect(false).catch(() => {});
  }

  private disconnectIfIdle(): void {
    if (!this.localTrack && !this.starting && this.watching.size === 0) this.disconnectRoom();
  }

  private isPeer(clientId: number): boolean {
    return clientId !== this.provider.selfId() && this.provider.selfChannelId() > 0
      && this.provider.membersOf(this.provider.selfChannelId()).some((member) => member.id === clientId);
  }

  private signal(targetId: number, kind: string, data = ''): void {
    if (this.provider.selfChannelId() > 0) {
      this.send({ t: Op.ScreenSignal, targetId, kind, data });
    }
  }
}

function identityToClientId(identity: string): number {
  const match = /^vox-\d+-(\d+)$/.exec(identity);
  const value = Number(match?.[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function describeScreenError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') return 'permissão negada';
    if (err.name === 'NotFoundError') return 'nenhuma tela ou janela disponível';
    return err.name;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 160 ? `${message.slice(0, 157)}...` : message;
}
