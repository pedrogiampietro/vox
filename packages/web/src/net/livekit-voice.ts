/**
 * Plano de contingencia da voz.
 *
 * O transporte Vox continua sendo mantido durante a migracao: ele atende
 * clientes antigos, enquanto os clientes que entraram no fallback conversam
 * entre si pela sala LiveKit. O marcador no frame de voz impede eco/duplicacao
 * entre os dois planos.
 */

import { Room, RoomEvent, Track } from 'livekit-client';
import type { RemoteAudioTrack, RemoteTrack } from 'livekit-client';
import type { LiveKitCredentials } from './connection.js';

export type LiveKitVoiceState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface LiveKitVoiceHandlers {
  onState(state: LiveKitVoiceState, detail: string): void;
  onTalkingChange?(): void;
}

interface RemoteAudio {
  track: RemoteAudioTrack;
  element: HTMLAudioElement;
  clientId: number;
  volume: number;
}

export class LiveKitVoice {
  private room: Room | null = null;
  private localTrack: import('livekit-client').LocalAudioTrack | null = null;
  private localSource: MediaStreamTrack | null = null;
  private readonly remotes = new Map<string, RemoteAudio>();
  private readonly peerVolumes = new Map<number, number>();
  private readonly peerMutes = new Map<number, boolean>();
  private readonly talking = new Set<number>();
  private generation = 0;
  private muted = false;
  private transmitting = false;
  private outputVolume = 1;
  private mutedSpeakers = false;
  private outputDeviceId = '';
  private _state: LiveKitVoiceState = 'idle';

  constructor(private readonly handlers: LiveKitVoiceHandlers) {}

  get state(): LiveKitVoiceState {
    return this._state;
  }

  get active(): boolean {
    return this._state === 'connected' || this._state === 'reconnecting';
  }

  async connect(
    credentials: LiveKitCredentials,
    sourceTrack: MediaStreamTrack,
    muted: boolean,
    transmitting: boolean,
  ): Promise<void> {
    this.disconnect(false);
    const generation = ++this.generation;
    const room = new Room({ adaptiveStream: true, dynacast: true });
    const source = sourceTrack.clone();
    source.enabled = transmitting && !muted;
    this.room = room;
    this.localSource = source;
    this.muted = muted;
    this.transmitting = transmitting;
    this.setState('connecting', 'conectando ao fallback LiveKit');

    room
      .on(RoomEvent.TrackSubscribed, (track, _publication, participant) => this.onTrackSubscribed(room, generation, track, participant.identity))
      .on(RoomEvent.TrackUnsubscribed, (track) => this.onTrackUnsubscribed(room, generation, track))
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        if (this.room !== room || generation !== this.generation) return;
        this.talking.clear();
        for (const participant of speakers) {
          const clientId = clientIdFromIdentity(participant.identity);
          if (clientId > 0) this.talking.add(clientId);
        }
        this.handlers.onTalkingChange?.();
      })
      .on(RoomEvent.Reconnecting, () => {
        if (this.room === room && generation === this.generation) this.setState('reconnecting', 'LiveKit reconectando');
      })
      .on(RoomEvent.Reconnected, () => {
        if (this.room === room && generation === this.generation) this.setState('connected', 'LiveKit conectado');
      })
      .on(RoomEvent.Disconnected, (reason) => {
        if (this.room !== room || generation !== this.generation) return;
        this.cleanupRoom(room, source);
        this.setState('failed', `LiveKit desconectou${reason ? `: ${String(reason)}` : ''}`);
      });

    try {
      await room.connect(credentials.url, credentials.token, { autoSubscribe: true });
      if (this.room !== room || generation !== this.generation) throw new Error('fallback LiveKit substituido');

      const publication = await room.localParticipant.publishTrack(source, {
        source: Track.Source.Microphone,
        name: 'microphone',
        dtx: true,
        red: true,
      });
      this.localTrack = publication.track as import('livekit-client').LocalAudioTrack;
      if (this.room !== room || generation !== this.generation) throw new Error('fallback LiveKit substituido');
      this.setState('connected', 'LiveKit ativo');
      this.applyLocalTrackState();
    } catch (error) {
      if (this.room === room && generation === this.generation) {
        this.cleanupRoom(room, source);
        this.setState('failed', describeError(error));
      }
      throw error;
    }
  }

  disconnect(notify = true): void {
    ++this.generation;
    const room = this.room;
    const source = this.localSource;
    this.room = null;
    this.localTrack = null;
    this.localSource = null;
    this.cleanupRemotes();
    if (room) void room.disconnect(false).catch(() => {});
    source?.stop();
    if (notify) this.setState('idle', 'fallback LiveKit desligado');
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyLocalTrackState();
  }

  setTransmissionEnabled(enabled: boolean): void {
    this.transmitting = enabled;
    this.applyLocalTrackState();
  }

  setOutputVolume(volume: number): void {
    this.outputVolume = clamp(volume);
    this.applyAllVolumes();
  }

  setMutedSpeakers(muted: boolean): void {
    this.mutedSpeakers = muted;
    this.applyAllVolumes();
  }

  setPeerVolume(clientId: number, volume: number): void {
    this.peerVolumes.set(clientId, clamp(volume));
    for (const remote of this.remotes.values()) {
      if (remote.clientId === clientId) this.applyVolume(remote);
    }
  }

  setPeerMuted(clientId: number, muted: boolean): void {
    this.peerMutes.set(clientId, muted);
    for (const remote of this.remotes.values()) {
      if (remote.clientId === clientId) this.applyVolume(remote);
    }
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    this.outputDeviceId = deviceId;
    const tasks: Promise<void>[] = [];
    for (const remote of this.remotes.values()) {
      if (!('setSinkId' in remote.element)) continue;
      tasks.push((remote.element as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(deviceId));
    }
    await Promise.allSettled(tasks);
  }

  isTalking(clientId: number): boolean {
    return this.talking.has(clientId);
  }

  private onTrackSubscribed(room: Room, generation: number, track: RemoteTrack, participantIdentity: string): void {
    if (this.room !== room || generation !== this.generation || track.kind !== Track.Kind.Audio) return;
    const audioTrack = track as RemoteAudioTrack;
    const element = audioTrack.attach() as HTMLAudioElement;
    element.autoplay = true;
    element.controls = false;
    element.hidden = true;
    element.dataset.voxLivekitVoice = 'true';
    document.body.append(element);
    const remote: RemoteAudio = {
      track: audioTrack,
      element,
      clientId: clientIdFromIdentity(participantIdentity),
      volume: 1,
    };
    this.remotes.set(trackKey(audioTrack), remote);
    this.applyVolume(remote);
    if (this.outputDeviceId) void this.setOutputDevice(this.outputDeviceId);
    void element.play().catch(() => room.startAudio().catch(() => {}));
  }

  private onTrackUnsubscribed(room: Room, generation: number, track: RemoteTrack): void {
    if (this.room !== room || generation !== this.generation || track.kind !== Track.Kind.Audio) return;
    const audioTrack = track as RemoteAudioTrack;
    const remote = this.remotes.get(trackKey(audioTrack));
    if (remote) {
      audioTrack.detach();
      remote.element.remove();
      this.remotes.delete(trackKey(audioTrack));
    }
  }

  private applyLocalTrackState(): void {
    const source = this.localSource;
    if (source) source.enabled = this.transmitting && !this.muted;
  }

  private applyAllVolumes(): void {
    for (const remote of this.remotes.values()) this.applyVolume(remote);
  }

  private applyVolume(remote: RemoteAudio): void {
    const peerVolume = this.peerVolumes.get(remote.clientId) ?? remote.volume;
    const volume = this.mutedSpeakers || this.peerMutes.get(remote.clientId) ? 0 : this.outputVolume * peerVolume;
    remote.track.setVolume(clamp(volume));
  }

  private cleanupRoom(room: Room, source: MediaStreamTrack): void {
    if (this.room !== room) return;
    this.room = null;
    this.localTrack = null;
    this.localSource = null;
    this.cleanupRemotes();
    void room.disconnect(false).catch(() => {});
    source.stop();
  }

  private cleanupRemotes(): void {
    for (const remote of this.remotes.values()) {
      remote.track.detach();
      remote.element.remove();
    }
    this.remotes.clear();
    this.talking.clear();
    this.handlers.onTalkingChange?.();
  }

  private setState(state: LiveKitVoiceState, detail: string): void {
    this._state = state;
    this.handlers.onState(state, detail);
  }
}

function clientIdFromIdentity(identity: string): number {
  const match = /^vox-voice-\d+-(\d+)$/.exec(identity);
  const value = Number(match?.[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function trackKey(track: RemoteAudioTrack): string {
  return track.sid ?? track.mediaStreamTrack.id;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 160 ? `${message.slice(0, 157)}...` : message;
}
