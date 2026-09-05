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

    this.reofferAll();
    this.onChange();
  }

  /** Envia oferta pra todos os membros do meu canal atual. */
  private reofferAll(): void {
    if (!this.localStream) return;
    const channelId = this.provider.selfChannelId();
    for (const member of this.provider.membersOf(channelId)) {
      if (member.id === this.provider.selfId()) continue;
      const existing = this.peers.get(member.id);
      // Pula se ja temos uma conexao enviando nossos tracks.
      if (existing && existing.getSenders().some((s) => s.track !== null)) continue;
      void this.offerTo(member.id);
    }
  }

  /**
   * Chamado quando alguem se move para o meu canal (ou entra novo no canal).
   * Se estou compartilhando, mando oferta pra eles verem a tela.
   */
  onPeerReachable(clientId: number): void {
    if (!this.localStream) return;
    if (clientId === this.provider.selfId()) return;
    const existing = this.peers.get(clientId);
    if (existing && existing.getSenders().some((s) => s.track !== null)) return;
    const channelId = this.provider.selfChannelId();
    const inMyChannel = this.provider.membersOf(channelId).some((m) => m.id === clientId);
    if (!inMyChannel) return;
    void this.offerTo(clientId);
  }

  /** Chamado quando EU mudei de canal. Fecha peers antigos e reoferece novos. */
  onSelfMoved(): void {
    if (!this.localStream) return;
    const channelId = this.provider.selfChannelId();
    const stillInChannel = new Set(this.provider.membersOf(channelId).map((m) => m.id));
    for (const [peerId, pc] of this.peers) {
      if (!stillInChannel.has(peerId)) {
        pc.close();
        this.peers.delete(peerId);
        this.signal(peerId, 'stop', '');
      }
    }
    this.reofferAll();
  }

  stop(): void {
    for (const track of this.localStream?.getTracks() ?? []) track.stop();
    this.localStream = null;
    // Fecha somente PCs que eram exclusivamente de envio.
    // PCs que tambem recebem tela de outro usuario sao mantidos.
    for (const [peerId, pc] of this.peers) {
      if (this.remotes.has(peerId)) {
        // Bidirecional: remove nossos tracks mas mantem a conexao para receber.
        for (const sender of pc.getSenders()) {
          if (sender.track) try { pc.removeTrack(sender); } catch {}
        }
      } else {
        pc.close();
        this.peers.delete(peerId);
      }
    }
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
        if (pc.signalingState === 'have-local-offer') {
          // Glare: ambos enviaram oferta ao mesmo tempo.
          // O lado com ID menor faz rollback e aceita a oferta do outro.
          if (senderId > this.provider.selfId()) {
            await pc.setLocalDescription({ type: 'rollback' });
          } else {
            return;
          }
        }
        await pc.setRemoteDescription(JSON.parse(data) as RTCSessionDescriptionInit);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.signal(senderId, 'answer', JSON.stringify(pc.localDescription));
        return;
      }
      if (kind === 'answer') {
        if (pc.signalingState !== 'have-local-offer') return;
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
    if (existing) {
      if (withLocalTracks && this.localStream) {
        const hasSendTrack = existing.getSenders().some((s) => s.track !== null);
        if (!hasSendTrack) {
          for (const track of this.localStream.getTracks()) existing.addTrack(track, this.localStream);
        }
      }
      return existing;
    }

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
