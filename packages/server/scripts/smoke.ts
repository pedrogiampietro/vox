/**
 * Teste de fumaca do servidor: dois clientes de verdade, sem navegador.
 *
 * Cobre o que a interface nao consegue verificar sozinha - o roteamento de voz.
 * Um pacote de voz sintetico tem que chegar a quem esta no mesmo canal, com o
 * id do remetente carimbado, e nao pode vazar para outro canal nem voltar para
 * quem falou.
 *
 * Os clientes daqui montam o mesmo estado que o cliente real monta, aplicando
 * Snapshot e eventos. As asercoes olham esse estado, nunca a mensagem que o
 * produziu: quem entra primeiro descobre o outro por evento, quem entra depois
 * descobre pelo snapshot, e as duas coisas sao corretas.
 *
 *   npx tsx packages/server/scripts/smoke.ts
 */

import { WebSocket } from 'ws';
import {
  ChatScope,
  FrameKind,
  Op,
  PROTOCOL_VERSION,
  decodeServerMessage,
  decodeVoice,
  encodeClientMessage,
  encodeVoice,
} from '@vox/protocol';
import type { ChannelInfo, ClientInfo, ClientMessage, ServerMessage } from '@vox/protocol';

const URL = process.env.VOX_URL ?? 'ws://127.0.0.1:9987/vox';

/** Sufixo por execucao, para o teste nao depender de estar sozinho no servidor. */
const RUN = Math.random().toString(36).slice(2, 8);

let failures = 0;

function check(label: string, ok: boolean): void {
  console.log(`${ok ? '  ok  ' : ' FALHA'}  ${label}`);
  if (!ok) failures++;
}

interface HeardVoice {
  clientId: number;
  seq: number;
  payload: number[];
}

class TestClient {
  private readonly ws: WebSocket;

  readonly channels = new Map<number, ChannelInfo>();
  readonly clients = new Map<number, ClientInfo>();
  readonly chat: { senderId: number; text: string }[] = [];
  readonly voice: HeardVoice[] = [];
  id = 0;

  constructor(readonly nickname: string) {
    this.ws = new WebSocket(URL);
    this.ws.binaryType = 'nodebuffer';
    this.ws.on('message', (data: Buffer) => {
      const frame = new Uint8Array(data);
      if (frame[0] === FrameKind.Voice) {
        const p = decodeVoice(frame);
        if (p) this.voice.push({ clientId: p.clientId, seq: p.seq, payload: [...p.payload] });
        return;
      }
      this.apply(decodeServerMessage(frame));
    });
  }

  private apply(m: ServerMessage): void {
    switch (m.t) {
      case Op.Welcome:
        this.id = m.clientId;
        break;
      case Op.Snapshot:
        this.channels.clear();
        this.clients.clear();
        for (const c of m.channels) this.channels.set(c.id, c);
        for (const c of m.clients) this.clients.set(c.id, c);
        break;
      case Op.ChannelAdd:
      case Op.ChannelUpdate:
        this.channels.set(m.channel.id, m.channel);
        break;
      case Op.ChannelRemove:
        this.channels.delete(m.channelId);
        break;
      case Op.ClientAdd:
        this.clients.set(m.client.id, m.client);
        break;
      case Op.ClientRemove:
        this.clients.delete(m.clientId);
        break;
      case Op.ClientMove: {
        const c = this.clients.get(m.clientId);
        if (c) c.channelId = m.channelId;
        break;
      }
      case Op.ClientState: {
        const c = this.clients.get(m.clientId);
        if (c) c.flags = m.flags;
        break;
      }
      case Op.ChatDeliver:
        this.chat.push({ senderId: m.senderId, text: m.text });
        break;
    }
  }

  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  hello(): void {
    this.send({ t: Op.Hello, version: PROTOCOL_VERSION, nickname: this.nickname, password: '' });
  }

  send(m: ClientMessage): void {
    this.ws.send(encodeClientMessage(m));
  }

  sendVoice(seq: number, payload: Uint8Array): void {
    this.ws.send(encodeVoice(seq, 0, payload));
  }

  /** Fecha e espera o socket morrer, para nao deixar sessao pendurada. */
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }

  channelNamed(name: string): ChannelInfo | undefined {
    for (const c of this.channels.values()) if (c.name === name) return c;
    return undefined;
  }

  get channelId(): number {
    return this.clients.get(this.id)?.channelId ?? -1;
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Espera uma condicao em vez de dormir um tempo fixo. Sleep fixo transforma
 * latencia em falha: o mesmo teste passa direto na maquina e falha atras do
 * NAT do Docker.
 */
async function until(label: string, ready: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return true;
    await wait(20);
  }
  check(`${label} (esgotou ${timeoutMs}ms)`, false);
  return false;
}

async function main(): Promise<void> {
  console.log(`conectando em ${URL}\n`);

  const alice = new TestClient(`alice-${RUN}`);
  const bob = new TestClient(`bob-${RUN}`);
  await Promise.all([alice.ready(), bob.ready()]);

  alice.hello();
  bob.hello();

  await until('handshake dos dois clientes', () => alice.id > 0 && bob.id > 0);
  check('handshake atribui ids distintos', alice.id > 0 && bob.id > 0 && alice.id !== bob.id);
  check('snapshot traz os canais', alice.channels.size >= 3);

  await until('os dois se enxergam', () => alice.clients.has(bob.id) && bob.clients.has(alice.id));
  check('alice ve o bob na lista', alice.clients.has(bob.id));
  check('bob ve a alice na lista', bob.clients.has(alice.id));
  check('os dois entram no mesmo canal padrao', alice.channelId === bob.channelId);

  // --- voz dentro do mesmo canal ------------------------------------------

  const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  alice.sendVoice(42, payload);
  await until('bob recebe algum pacote de voz', () => bob.voice.length > 0);

  const heard = bob.voice.at(-1);
  check('bob recebe a voz da alice', heard !== undefined);
  check('o pacote chega carimbado com o id da alice', heard?.clientId === alice.id);
  check('o seq e preservado', heard?.seq === 42);
  check('o payload chega intacto', heard?.payload.join() === [...payload].join());
  check('alice nao ouve a si mesma', alice.voice.length === 0);

  // --- isolamento entre canais --------------------------------------------

  const other = alice.channelNamed('Sala 1');
  check('existe um segundo canal para o teste', other !== undefined);
  if (other) {
    alice.send({ t: Op.JoinChannel, channelId: other.id, password: '' });
    const moved = await until(
      'bob ve a alice no outro canal',
      () => bob.clients.get(alice.id)?.channelId === other.id,
    );
    check('a mudanca de canal chega ao bob', moved);

    // So depois da mudanca confirmada nao ha mais pacote antigo em voo.
    const before = bob.voice.length;
    alice.sendVoice(43, payload);
    await wait(400);
    check('voz nao vaza para outro canal', bob.voice.length === before);
  }

  // --- chat ----------------------------------------------------------------

  const line = `ola ${RUN}`;
  bob.send({ t: Op.ChatSend, scope: ChatScope.Server, targetId: 0, text: line });
  const delivered = await until('chat de servidor circula', () =>
    bob.chat.some((c) => c.senderId === bob.id && c.text === line),
  );
  check('chat volta para o remetente com o texto intacto', delivered);
  check('chat de servidor alcanca quem esta em outro canal', alice.chat.some((c) => c.text === line));

  // --- saida ---------------------------------------------------------------

  await alice.close();
  const sawExit = await until('bob ve a saida da alice', () => !bob.clients.has(alice.id));
  check('a saida da alice chega ao bob', sawExit);

  await bob.close();
  console.log(failures === 0 ? '\ntudo passou' : `\n${failures} verificacao(oes) falharam`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('erro no teste:', err);
  process.exit(1);
});
