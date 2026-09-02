import { Op } from '@vox/protocol';
import type { ClientInfo, ClientMessage } from '@vox/protocol';

type SignalKind = 'offer' | 'answer' | 'candidate' | 'stop';

export interface RemoteScreen {
  clientId: number;
  stream: MediaStream;
}

export interface ScreenPeerProvider {
  selfId(): number;
  selfChannelId(): number;
  membersOf(channelId: number): ClientInfo[];
}

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

export class ScreenShare {
  readonly remotes = new Map<number, RemoteScreen>();
  localStream: MediaStream | null = null;
  error = '';

  private readonly peers = new Map<number, RTCPeerConnection>();

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
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.error = 'compartilhamento de tela indisponivel neste navegador';
      this.onChange();
      return;
    }

    try {
      this.localStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 30 } },
        audio: false,
      });
    } catch (err) {
      this.error = describeDisplayError(err);
      this.onChange();
      return;
    }

    for (const track of this.localStream.getTracks()) {
      track.addEventListener('ended', () => this.stop(), { once: true });
    }

    const channelId = this.provider.selfChannelId();
    for (const member of this.provider.membersOf(channelId)) {
      if (member.id !== this.provider.selfId()) void this.offerTo(member.id);
    }
    this.onChange();
  }

  stop(): void {
    for (const track of this.localStream?.getTracks() ?? []) track.stop();
    this.localStream = null;
    for (const pc of this.peers.values()) pc.close();
    this.peers.clear();
    this.signal(0, 'stop', '');
    this.onChange();
  }

  close(): void {
    this.stop();
    this.remotes.clear();
    this.error = '';
  }

  async handleSignal(senderId: number, targetId: number, kind: string, data: string): Promise<void> {
    if (targetId > 0 && targetId !== this.provider.selfId()) return;
    if (!isSignalKind(kind)) return;

    if (kind === 'stop') {
      this.dropRemote(senderId);
      return;
    }

    const pc = this.peerFor(senderId, false);
    try {
      if (kind === 'offer') {
        await pc.setRemoteDescription(JSON.parse(data) as RTCSessionDescriptionInit);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.signal(senderId, 'answer', JSON.stringify(pc.localDescription));
        return;
      }
      if (kind === 'answer') {
        await pc.setRemoteDescription(JSON.parse(data) as RTCSessionDescriptionInit);
        return;
      }
      if (kind === 'candidate' && data) {
        await pc.addIceCandidate(JSON.parse(data) as RTCIceCandidateInit);
      }
    } catch (err) {
      this.error = `falha no compartilhamento: ${String(err)}`;
      this.dropRemote(senderId);
      this.onChange();
    }
  }

  private async offerTo(clientId: number): Promise<void> {
    const pc = this.peerFor(clientId, true);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signal(clientId, 'offer', JSON.stringify(pc.localDescription));
  }

  private peerFor(clientId: number, withLocalTracks: boolean): RTCPeerConnection {
    const existing = this.peers.get(clientId);
    if (existing) return existing;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.peers.set(clientId, pc);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.signal(clientId, 'candidate', JSON.stringify(ev.candidate));
    };
    pc.ontrack = (ev) => {
      const stream = ev.streams[0];
      if (!stream) return;
      this.remotes.set(clientId, { clientId, stream });
      this.onChange();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
        this.dropRemote(clientId);
      }
    };

    if (withLocalTracks && this.localStream) {
      for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);
    }

    return pc;
  }

  private dropRemote(clientId: number): void {
    this.peers.get(clientId)?.close();
    this.peers.delete(clientId);
    this.remotes.delete(clientId);
    this.onChange();
  }

  private signal(targetId: number, kind: SignalKind, data: string): void {
    this.send({ t: Op.ScreenSignal, targetId, kind, data });
  }
}

function isSignalKind(kind: string): kind is SignalKind {
  return kind === 'offer' || kind === 'answer' || kind === 'candidate' || kind === 'stop';
}

function describeDisplayError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') return 'permissao negada';
    if (err.name === 'NotFoundError') return 'nenhuma tela ou janela disponivel';
    return err.name;
  }
  return String(err);
}
