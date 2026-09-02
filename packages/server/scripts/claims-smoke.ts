import { webcrypto } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  FrameKind,
  Op,
  PROTOCOL_VERSION,
  decodeServerMessage,
  encodeClientMessage,
} from '@vox/protocol';
import type { ClientMessage, RespClaimInfo } from '@vox/protocol';

const URL = process.env['VOX_URL'] ?? 'ws://127.0.0.1:9987/vox';

const KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' } as const;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function identity(): Promise<{ spki: Uint8Array; key: CryptoKey }> {
  const pair = await webcrypto.subtle.generateKey(KEY_ALGORITHM, true, ['sign', 'verify']);
  const spki = new Uint8Array(await webcrypto.subtle.exportKey('spki', pair.publicKey));
  return { spki, key: pair.privateKey };
}

class TestClient {
  private readonly ws = new WebSocket(URL);
  private identity: { spki: Uint8Array; key: CryptoKey } | null = null;
  claims: RespClaimInfo[] = [];
  id = 0;

  constructor(private readonly nickname: string) {
    this.ws.binaryType = 'nodebuffer';
    this.ws.on('message', (data: Buffer) => void this.receive(new Uint8Array(data)));
  }

  async ready(): Promise<void> {
    this.identity = await identity();
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.send({
      t: Op.Hello,
      version: PROTOCOL_VERSION,
      nickname: this.nickname,
      password: '',
      publicKey: this.identity.spki,
      platform: 'smoke',
    });
    await until(() => this.id > 0, 'cliente autenticado');
  }

  send(m: ClientMessage): void {
    this.ws.send(encodeClientMessage(m));
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }

  private async receive(frame: Uint8Array): Promise<void> {
    if (frame[0] !== FrameKind.Control) return;
    const m = decodeServerMessage(frame);
    if (m.t === Op.Challenge) {
      if (!this.identity) return;
      const signature = new Uint8Array(
        await webcrypto.subtle.sign(SIGN_ALGORITHM, this.identity.key, m.nonce),
      );
      this.send({ t: Op.Auth, signature });
    } else if (m.t === Op.Welcome) {
      this.id = m.clientId;
    } else if (m.t === Op.Snapshot || m.t === Op.RespClaims) {
      this.claims = m.claims;
    }
  }
}

async function until(check: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait(20);
  }
  throw new Error(`${label} nao aconteceu em ${timeoutMs}ms`);
}

async function main(): Promise<void> {
  console.log(`claims smoke em ${URL}`);
  const alice = new TestClient('alice-claim');
  const bob = new TestClient('bob-claim');
  await Promise.all([alice.ready(), bob.ready()]);

  alice.send({ t: Op.ClaimResp, respawn: 'Cobra Bastion', note: 'EK+ED', durationMin: 120 });
  await until(() => bob.claims.some((c) => c.respawn === 'Cobra Bastion'), 'claim sincronizado');
  const claim = bob.claims.find((c) => c.respawn === 'Cobra Bastion');
  if (!claim) throw new Error('claim nao encontrado');
  console.log(`ok claim: ${claim.respawn} por ${claim.ownerName}`);

  bob.send({ t: Op.JoinRespQueue, claimId: claim.id });
  await until(
    () => alice.claims.some((c) => c.id === claim.id && c.queue.some((q) => q.name === 'bob-claim')),
    'fila sincronizada',
  );
  console.log('ok queue');

  alice.send({ t: Op.ReleaseResp, claimId: claim.id });
  await until(
    () => bob.claims.some((c) => c.id === claim.id && c.ownerName === 'bob-claim'),
    'proximo promovido',
  );
  console.log('ok promote next');

  const promoted = bob.claims.find((c) => c.id === claim.id);
  if (!promoted) throw new Error('claim promovido nao encontrado');
  bob.send({ t: Op.ReleaseResp, claimId: promoted.id });
  await until(() => !alice.claims.some((c) => c.id === claim.id), 'claim liberado');
  console.log('ok release');

  await Promise.all([alice.close(), bob.close()]);
}

main().catch((err) => {
  console.error('falha no claims smoke:', err);
  process.exit(1);
});
