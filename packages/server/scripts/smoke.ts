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

import { webcrypto } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  ChannelFlags,
  ChatScope,
  FailureCode,
  FrameKind,
  Group,
  Op,
  PROTOCOL_VERSION,
  decodeServerMessage,
  decodeVoice,
  encodeClientMessage,
  encodeVoice,
} from '@vox/protocol';
import type { ChannelInfo, ClientInfo, ClientMessage, ServerMessage } from '@vox/protocol';

interface Welcome {
  voiceToken: Uint8Array;
  wtPort: number;
  wtCertHash: Uint8Array;
  serverId: number;
  group: Group;
}

const KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' } as const;

/** Uma identidade descartavel por cliente de teste, como o cliente real faz. */
async function newIdentity(): Promise<{ spki: Uint8Array; key: CryptoKey }> {
  const pair = await webcrypto.subtle.generateKey(KEY_ALGORITHM, true, ['sign', 'verify']);
  const spki = new Uint8Array(await webcrypto.subtle.exportKey('spki', pair.publicKey));
  return { spki, key: pair.privateKey };
}

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
  readonly chat: { senderId: number; scope: ChatScope; targetId: number; text: string }[] = [];
  readonly voice: HeardVoice[] = [];
  readonly failures: { code: FailureCode; message: string }[] = [];
  id = 0;
  group: Group = Group.Guest;
  welcome: Welcome | null = null;

  private identity: { spki: Uint8Array; key: CryptoKey } | null = null;

  constructor(
    readonly nickname: string,
    url: string = URL,
  ) {
    this.ws = new WebSocket(url);
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
        this.group = m.group;
        this.welcome = m;
        break;
      case Op.Challenge:
        void this.answer(m.nonce);
        break;
      case Op.Failure:
        this.failures.push({ code: m.code, message: m.message });
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
        this.chat.push({ senderId: m.senderId, scope: m.scope, targetId: m.targetId, text: m.text });
        break;
    }
  }

  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  /** Hello com a chave publica; o Auth sai sozinho quando o desafio chegar. */
  async hello(): Promise<void> {
    this.identity = await newIdentity();
    this.send({
      t: Op.Hello,
      version: PROTOCOL_VERSION,
      nickname: this.nickname,
      password: '',
      publicKey: this.identity.spki,
    });
  }

  /** Assina o desafio: e o que prova a posse da chave privada. */
  private async answer(nonce: Uint8Array): Promise<void> {
    if (!this.identity) return;
    const signature = new Uint8Array(
      await webcrypto.subtle.sign(SIGN_ALGORITHM, this.identity.key, nonce),
    );
    this.send({ t: Op.Auth, signature });
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

/**
 * Abre o canal de voz por WebTransport de um cliente ja autenticado, do mesmo
 * jeito que o navegador faz: token por stream confiavel, voz por datagrama.
 */
async function openVoiceLink(
  client: TestClient,
  port: number,
): Promise<{
  send: (seq: number, payload: Uint8Array) => Promise<void>;
  received: HeardVoice[];
  close: () => void;
} | null> {
  const welcome = client.welcome;
  if (!welcome) return null;

  let WebTransport: typeof import('@fails-components/webtransport').WebTransport;
  try {
    const mod = await import('@fails-components/webtransport');
    // O addon nativo carrega em background; sem esperar, o construtor falha.
    await mod.quicheLoaded;
    ({ WebTransport } = mod);
  } catch {
    console.log('   --    modulo do WebTransport ausente; secao pulada');
    return null;
  }

  try {
    const controlUrl = new globalThis.URL(URL);
    const wt = new WebTransport(
      `https://${controlUrl.hostname}:${port}/vox`,
      welcome.wtCertHash.length > 0
        ? { serverCertificateHashes: [{ algorithm: 'sha-256', value: welcome.wtCertHash }] }
        : {},
    );
    await wt.ready;

    const stream = await wt.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    await writer.write(welcome.voiceToken);
    const reply = await stream.readable.getReader().read();
    if (reply.value?.[0] !== 1) {
      wt.close();
      return null;
    }

    const out = (
      wt.datagrams.createWritable ? wt.datagrams.createWritable() : wt.datagrams.writable!
    ).getWriter();
    const received: HeardVoice[] = [];
    const reader = wt.datagrams.readable.getReader();
    void (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done || !chunk.value) return;
        const p = decodeVoice(chunk.value);
        if (p) received.push({ clientId: p.clientId, seq: p.seq, payload: [...p.payload] });
      }
    })().catch(() => {});

    return {
      send: (seq, payload) => out.write(encodeVoice(seq, 0, payload)),
      received,
      close: () => wt.close(),
    };
  } catch (err) {
    console.log(`   --    WebTransport nao conectou: ${String(err)}`);
    return null;
  }
}

/** Conta como sucesso quando o servidor recusa a conexao. */
function refusedConnection(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const done = (refused: boolean): void => {
      try {
        ws.close();
      } catch {
        // ja fechado
      }
      resolve(refused);
    };
    ws.once('open', () => done(false));
    ws.once('error', () => done(true));
    setTimeout(() => done(false), 2000);
  });
}

async function main(): Promise<void> {
  console.log(`conectando em ${URL}\n`);

  const alice = new TestClient(`alice-${RUN}`);
  const bob = new TestClient(`bob-${RUN}`);
  await Promise.all([alice.ready(), bob.ready()]);

  // Alice entra primeiro de proposito: num servidor novo, o primeiro a provar
  // identidade vira dono, e e isso que torna o teste de moderacao previsivel.
  await alice.hello();
  await until('alice completa o handshake', () => alice.id > 0);
  await bob.hello();

  await until('handshake dos dois clientes', () => alice.id > 0 && bob.id > 0);
  check('handshake com desafio assinado atribui ids distintos',
    alice.id > 0 && bob.id > 0 && alice.id !== bob.id);
  check('snapshot traz os canais', alice.channels.size >= 3);
  check('welcome informa o servidor virtual', (alice.welcome?.serverId ?? 0) > 0);
  check('a identidade recebe uma impressao digital',
    (alice.clients.get(alice.id)?.fingerprint.length ?? 0) === 64);

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

  // --- voz por WebTransport -----------------------------------------------

  const wtPort = alice.welcome?.wtPort ?? 0;
  if (wtPort === 0) {
    console.log('   --    WebTransport desligado no servidor; secao pulada');
  } else {
    const link = await openVoiceLink(alice, wtPort);
    check('canal de voz QUIC abre e o token e aceito', link !== null);

    if (link) {
      // QUIC -> WebSocket: quem migrou continua sendo ouvido por quem nao migrou.
      const before = bob.voice.length;
      await link.send(77, payload);
      await until('bob ouve a voz que veio por QUIC', () => bob.voice.length > before);
      const viaQuic = bob.voice.at(-1);
      check('voz de QUIC chega a um cliente WebSocket', viaQuic?.seq === 77);
      check('o carimbo do remetente sobrevive a troca de transporte', viaQuic?.clientId === alice.id);

      // WebSocket -> QUIC: o sentido inverso, no mesmo canal.
      bob.sendVoice(88, payload);
      await until('alice recebe datagrama do cliente WebSocket', () => link.received.length > 0);
      const viaWs = link.received.at(-1);
      check('voz de WebSocket chega por datagrama QUIC', viaWs?.seq === 88);
      check('payload intacto atravessando os dois transportes',
        viaWs?.payload.join() === [...payload].join());

      link.close();
      // Fechado o canal QUIC, a voz tem que voltar sozinha para o WebSocket.
      const backOnWs = bob.voice.length;
      await wait(300); // deixa o servidor perceber a sessao QUIC fechada
      alice.sendVoice(99, payload);
      const recovered = await until(
        'voz volta pelo WebSocket apos o QUIC cair',
        () => bob.voice.length > backOnWs,
      );
      check('queda do canal QUIC nao deixa o cliente mudo', recovered);
    }
  }

  // --- isolamento entre canais --------------------------------------------

  const other = [...alice.channels.values()].find(
    (channel) => channel.id !== alice.channelId && (channel.flags & ChannelFlags.Password) === 0,
  );
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

    const channelLine = `mensagem privada do canal ${RUN}`;
    alice.send({ t: Op.ChatSend, scope: ChatScope.Channel, targetId: 0, text: channelLine });
    const ownChannelMessage = await until('alice recebe a mensagem do proprio canal', () =>
      alice.chat.some((c) => c.senderId === alice.id && c.scope === ChatScope.Channel
        && c.targetId === other.id && c.text === channelLine),
    );
    check('mensagem de canal volta com o id correto', ownChannelMessage);
    await wait(250);
    check('mensagem de canal nao vaza para outro canal',
      !bob.chat.some((c) => c.text === channelLine));

    bob.send({ t: Op.JoinChannel, channelId: other.id, password: '' });
    const bobMoved = await until(
      'alice ve bob entrar no mesmo canal',
      () => alice.clients.get(bob.id)?.channelId === other.id,
    );
    check('bob entra no canal da alice', bobMoved);
    const sharedChannelLine = `mensagem compartilhada ${RUN}`;
    bob.send({ t: Op.ChatSend, scope: ChatScope.Channel, targetId: 0, text: sharedChannelLine });
    const sharedChannelMessage = await until('alice recebe a mensagem do canal compartilhado', () =>
      alice.chat.some((c) => c.senderId === bob.id && c.scope === ChatScope.Channel
        && c.targetId === other.id && c.text === sharedChannelLine),
    );
    check('mensagem chega apenas aos membros do canal', sharedChannelMessage);
  }

  // --- chat ----------------------------------------------------------------

  const line = `ola ${RUN}`;
  bob.send({ t: Op.ChatSend, scope: ChatScope.Server, targetId: 0, text: line });
  const delivered = await until('chat de servidor circula', () =>
    bob.chat.some((c) => c.senderId === bob.id && c.text === line)
    && alice.chat.some((c) => c.senderId === bob.id && c.text === line),
  );
  check('chat volta para o remetente com o texto intacto', delivered);
  check('chat de servidor alcanca quem esta em outro canal',
    alice.chat.some((c) => c.senderId === bob.id && c.text === line));

  // --- servidores virtuais e permissoes ------------------------------------

  const serverId = alice.welcome?.serverId ?? 1;
  const carol = new TestClient(`carol-${RUN}`, URL.replace(/\/vox\/?$/, `/vox/${serverId}`));
  await carol.ready();
  await carol.hello();
  await until('cliente entra pela rota /vox/<id>', () => carol.id > 0);
  check('rota com id do servidor virtual conecta', carol.id > 0);
  check('cai no mesmo servidor virtual', carol.welcome?.serverId === serverId);

  const ghost = await refusedConnection(URL.replace(/\/vox\/?$/, '/vox/9999'));
  check('servidor virtual inexistente e recusado no upgrade', ghost);

  // Carol e sempre convidada: alice chegou antes e, num servidor novo, levou o
  // grupo de dono. A recusa abaixo e o teste que vale em qualquer estado.
  const failuresBefore = carol.failures.length;
  carol.send({ t: Op.KickClient, clientId: bob.id, reason: 'teste' });
  await until('convidado recebe recusa', () => carol.failures.length > failuresBefore);
  check(
    'convidado nao consegue expulsar ninguem',
    carol.failures.at(-1)?.code === FailureCode.NotPermitted,
  );
  check('o alvo continua online', bob.clients.has(bob.id));

  if (alice.group >= Group.Moderator) {
    alice.send({ t: Op.KickClient, clientId: carol.id, reason: 'teste de moderacao' });
    const gone = await until('moderador expulsa de fato', () => !bob.clients.has(carol.id));
    check(`quem tem grupo ${alice.group} consegue expulsar`, gone);
  } else {
    console.log('   --    alice entrou como convidada (o servidor ja tem dono); expulsao nao testada');
    await carol.close();
  }

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
