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
}

export interface ScreenPeerProvider {
  selfId(): number;
  selfChannelId(): number;
  membersOf(channelId: number): ClientInfo[];
  requestLiveKitToken(channelId: number): Promise<LiveKitCredentials>;
}

/**
 * Compartilhamento via SFU: o navegador publica uma vez e o LiveKit entrega
 * a tela aos espectadores. O socket Vox continua reservado para controle e
 * voz, então uma tela pesada não cria uma conexão P2P por pessoa.
 */
export class ScreenShare {
  readonly remotes = new Map<number, RemoteScreen>();
  localStream: MediaStream | null = null;
  error = '';

  private room: Room | null = null;
  private roomChannelId = 0;
  private connectingRoom: Promise<Room> | null = null;
  private localTrack: LocalTrack | null = null;

  constructor(
    private readonly provider: ScreenPeerProvider,
    private readonly send: (m: ClientMessage) => void,
    private readonly onChange: () => void,
  ) {}

  get sharing(): boolean {
    return this.localStream !== null;
  }

  async toggle(): Promise<void> {
    if (this.localStream) {
      this.stop();
      return;
    }
    await this.start();
  }

  async start(): Promise<void> {
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

    let track: LocalTrack | null = null;
    try {
      const credentials = await this.provider.requestLiveKitToken(channelId);
      const room = await this.ensureRoom(channelId, credentials);
      const tracks = await createLocalScreenTracks({
        audio: false,
        resolution: { width: 1280, height: 720, frameRate: 15 },
        contentHint: 'detail',
      });
      track = tracks.find((candidate) => candidate.kind === Track.Kind.Video) ?? null;
      if (!track) throw new Error('nenhuma faixa de video foi capturada');

      await room.localParticipant.publishTrack(track, this.publishOptions());
      if (this.room !== room || this.roomChannelId !== channelId) {
        track.stop();
        return;
      }
      this.localTrack = track;
      this.localStream = new MediaStream([track.mediaStreamTrack]);
      track.mediaStreamTrack.addEventListener('ended', () => {
        if (this.localTrack === track) this.stop();
      }, { once: true });
      this.signal(0, 'livekit-start');
      this.onChange();
    } catch (err) {
      track?.stop();
      this.error = describeScreenError(err);
      this.onChange();
      if (!this.localTrack && this.remotes.size === 0) this.disconnectRoom();
    }
  }

  /** Anuncia a tela para uma pessoa que acabou de chegar no canal. */
  onPeerReachable(clientId: number): void {
    if (!this.localStream || clientId === this.provider.selfId()) return;
    const channelId = this.provider.selfChannelId();
    if (!this.provider.membersOf(channelId).some((member) => member.id === clientId)) return;
    this.signal(clientId, 'livekit-start');
  }

  /** Troca a sala SFU quando o usuario muda de canal. */
  onSelfMoved(): void {
    const channelId = this.provider.selfChannelId();
    if (this.roomChannelId === 0 || this.roomChannelId === channelId) return;

    const oldRoom = this.room;
    const local = this.localTrack;
    this.room = null;
    this.roomChannelId = 0;
    this.remotes.clear();
    if (oldRoom) {
      if (local) void oldRoom.localParticipant.unpublishTrack(local, false).catch(() => {});
      void oldRoom.disconnect(false).catch(() => {});
    }

    if (local && channelId > 0) {
      void this.republishAfterMove(local, channelId);
    } else {
      this.onChange();
    }
  }

  stop(): void {
    const local = this.localTrack;
    const room = this.room;
    this.localTrack = null;
    this.localStream = null;
    if (local) {
      if (room) void room.localParticipant.unpublishTrack(local, false).catch(() => {});
      local.stop();
      this.signal(0, 'livekit-stop');
    }
    if (this.remotes.size === 0) this.disconnectRoom();
    this.onChange();
  }

  close(): void {
    const local = this.localTrack;
    this.localTrack = null;
    this.localStream = null;
    local?.stop();
    this.remotes.clear();
    this.disconnectRoom();
    this.error = '';
  }

  /** Recebe apenas os pequenos eventos de presença pelo controle Vox. */
  async handleSignal(senderId: number, targetId: number, kind: string, _data: string): Promise<void> {
    if (targetId > 0 && targetId !== this.provider.selfId()) return;
    if (senderId === this.provider.selfId()) return;

    if (kind === 'livekit-start') {
      const channelId = this.provider.selfChannelId();
      if (channelId <= 0) return;
      try {
        await this.ensureRoom(channelId);
      } catch (err) {
        this.error = describeScreenError(err);
        this.onChange();
      }
      return;
    }

    if (kind === 'livekit-stop') {
      this.dropRemote(senderId);
      if (!this.localTrack && this.remotes.size === 0) this.disconnectRoom();
    }
  }

  private async ensureRoom(channelId: number, credentials?: LiveKitCredentials): Promise<Room> {
    if (this.room && this.roomChannelId === channelId) return this.room;
    if (this.connectingRoom) return this.connectingRoom;

    const promise = (async () => {
      const access = credentials ?? await this.provider.requestLiveKitToken(channelId);
      const room = new Room({ adaptiveStream: true, dynacast: true });
      this.room = room;
      this.roomChannelId = channelId;
      this.bindRoom(room);
      try {
        await room.connect(access.url, access.token, { autoSubscribe: true });
        this.attachExistingTracks(room);
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
    room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      this.addRemote(track, participant.identity);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
      if (track.kind === Track.Kind.Video) this.dropRemote(identityToClientId(participant.identity));
    });
    room.on(RoomEvent.TrackUnpublished, (publication, participant) => {
      if (publication.kind === Track.Kind.Video) this.dropRemote(identityToClientId(participant.identity));
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      this.dropRemote(identityToClientId(participant.identity));
    });
    room.on(RoomEvent.Disconnected, () => {
      if (this.room !== room) return;
      this.room = null;
      this.roomChannelId = 0;
      this.remotes.clear();
      if (this.localTrack) {
        this.localTrack.stop();
        this.localTrack = null;
        this.localStream = null;
      }
      this.onChange();
    });
  }

  private attachExistingTracks(room: Room): void {
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        const track = publication.track;
        if (track && track.kind === Track.Kind.Video) this.addRemote(track as RemoteTrack, participant.identity);
      }
    }
  }

  private addRemote(track: RemoteTrack, identity: string): void {
    if (track.kind !== Track.Kind.Video) return;
    const clientId = identityToClientId(identity);
    if (clientId <= 0 || clientId === this.provider.selfId()) return;
    this.remotes.set(clientId, {
      clientId,
      stream: new MediaStream([track.mediaStreamTrack]),
    });
    this.onChange();
  }

  private dropRemote(clientId: number): void {
    if (clientId <= 0 || !this.remotes.delete(clientId)) return;
    this.onChange();
  }

  private async republishAfterMove(local: LocalTrack, channelId: number): Promise<void> {
    try {
      const room = await this.ensureRoom(channelId);
      if (this.localTrack !== local) return;
      await room.localParticipant.publishTrack(local, this.publishOptions());
      this.signal(0, 'livekit-start');
      this.onChange();
    } catch (err) {
      if (this.localTrack !== local) return;
      this.localTrack = null;
      this.localStream = null;
      local.stop();
      this.error = describeScreenError(err);
      this.onChange();
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
    if (room) void room.disconnect().catch(() => {});
  }

  private signal(targetId: number, kind: 'livekit-start' | 'livekit-stop'): void {
    this.send({ t: Op.ScreenSignal, targetId, kind, data: '' });
  }
}

function identityToClientId(identity: string): number {
  const value = Number(identity.split('-').at(-1));
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function describeScreenError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') return 'permissao negada';
    if (err.name === 'NotFoundError') return 'nenhuma tela ou janela disponivel';
    return err.name;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 160 ? `${message.slice(0, 157)}...` : message;
}
