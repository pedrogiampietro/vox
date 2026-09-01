/**
 * Canal de controle: mensagens confiaveis e ordenadas.
 *
 * Todo frame comeca com FrameKind.Control seguido do opcode. As unions abaixo
 * sao a fonte unica da verdade - servidor e cliente compartilham o mesmo
 * arquivo, entao um campo novo quebra a compilacao dos dois lados de uma vez.
 */

import { Reader, Writer } from './codec.js';
import type { ChannelInfo, ClientInfo, GroupDef } from './types.js';
import { ChatScope, FailureCode, FrameKind, Group, Op, RemoveReason } from './types.js';

export type ClientMessage =
  | {
      t: Op.Hello;
      version: number;
      nickname: string;
      password: string;
      /** Chave publica SPKI. Vazia = sessao anonima, sempre convidado. */
      publicKey: Uint8Array;
      platform: string;
    }
  | { t: Op.Auth; signature: Uint8Array }
  | { t: Op.Ping; stamp: number }
  | { t: Op.JoinChannel; channelId: number; password: string }
  | { t: Op.CreateChannel; name: string; parentId: number; maxClients: number; password: string }
  | { t: Op.DeleteChannel; channelId: number }
  | { t: Op.EditChannel; channelId: number; name: string; topic: string; maxClients: number }
  | { t: Op.ChatSend; scope: ChatScope; targetId: number; text: string }
  | { t: Op.SetSelfState; flags: number; nickname?: string }
  | { t: Op.KickClient; clientId: number; reason: string }
  | { t: Op.BanClient; clientId: number; reason: string; minutes: number }
  | { t: Op.MoveClient; clientId: number; channelId: number }
  | { t: Op.SetClientGroup; clientId: number; group: Group }
  | { t: Op.SetGroupDef; group: Group; name: string; icon: string; color: string }
  | { t: Op.BotCommand; command: string; args: string[] };

export type ServerMessage =
  | { t: Op.Challenge; nonce: Uint8Array }
  | {
      t: Op.Welcome;
      clientId: number;
      /** Servidor virtual em que a sessao entrou. */
      serverId: number;
      serverName: string;
      motd: string;
      /** Grupo concedido a esta sessao. */
      group: Group;
      /** Prova a identidade da sessao ao abrir o canal de voz separado. */
      voiceToken: Uint8Array;
      /** Porta UDP do WebTransport; 0 quando o servidor nao oferece. */
      wtPort: number;
      /**
       * SHA-256 do certificado, para serverCertificateHashes. Vazio em
       * producao, onde o certificado e valido e o navegador nao precisa de
       * ajuda. Preenchido em desenvolvimento, com certificado proprio.
       */
      wtCertHash: Uint8Array;
    }
  | { t: Op.Pong; stamp: number }
  | { t: Op.Failure; code: FailureCode; message: string }
  | { t: Op.Snapshot; channels: ChannelInfo[]; clients: ClientInfo[] }
  | { t: Op.ChannelAdd; channel: ChannelInfo }
  | { t: Op.ChannelRemove; channelId: number }
  | { t: Op.ChannelUpdate; channel: ChannelInfo }
  | { t: Op.ClientAdd; client: ClientInfo }
  | { t: Op.ClientRemove; clientId: number; reason: RemoveReason }
  | { t: Op.ClientMove; clientId: number; channelId: number }
  | { t: Op.ClientState; clientId: number; flags: number }
  | {
      t: Op.ChatDeliver;
      scope: ChatScope;
      senderId: number;
      senderName: string;
      text: string;
      stamp: number;
      targetId: number;
    }
  | { t: Op.GroupDefs; groups: GroupDef[] }
  | { t: Op.BotCommandResult; success: boolean; message: string; data?: unknown };

export const MAX_CONTROL_FRAME = 64 * 1024;
export const MAX_NICKNAME = 32;
export const MAX_CHAT_TEXT = 1024;

// ---------------------------------------------------------------- channels --

function writeChannel(w: Writer, c: ChannelInfo): void {
  w.u16(c.id).u16(c.parentId).u16(c.order).str(c.name).str(c.topic).u16(c.maxClients).u8(c.flags);
}

function readChannel(r: Reader): ChannelInfo {
  return {
    id: r.u16(),
    parentId: r.u16(),
    order: r.u16(),
    name: r.str(),
    topic: r.str(),
    maxClients: r.u16(),
    flags: r.u8(),
  };
}

function writeClient(w: Writer, c: ClientInfo): void {
  w.u16(c.id).u16(c.channelId).str(c.nickname).u8(c.flags).u8(c.group).str(c.fingerprint);
  w.u32(Math.floor((c.connectedAt || 0) / 1000)).str(c.platform || '');
}

function readClient(r: Reader): ClientInfo {
  return {
    id: r.u16(),
    channelId: r.u16(),
    nickname: r.str(),
    flags: r.u8(),
    group: r.u8() as Group,
    fingerprint: r.str(),
    connectedAt: r.u32() * 1000,
    platform: r.str(),
  };
}

// ----------------------------------------------------------------- groups --

function writeGroupDef(w: Writer, g: GroupDef): void {
  w.u8(g.id).str(g.name).str(g.icon).str(g.color);
}

function readGroupDef(r: Reader): GroupDef {
  return { id: r.u8() as Group, name: r.str(), icon: r.str(), color: r.str() };
}

// ------------------------------------------------------- cliente -> servidor --

export function encodeClientMessage(m: ClientMessage): Uint8Array {
  const w = new Writer(128).u8(FrameKind.Control).u8(m.t);
  switch (m.t) {
    case Op.Hello:
      w.u16(m.version).str(m.nickname).str(m.password).bytes(m.publicKey).str(m.platform);
      break;
    case Op.Auth:
      w.bytes(m.signature);
      break;
    case Op.Ping:
      w.f64(m.stamp);
      break;
    case Op.JoinChannel:
      w.u16(m.channelId).str(m.password);
      break;
    case Op.CreateChannel:
      w.str(m.name).u16(m.parentId).u16(m.maxClients).str(m.password);
      break;
    case Op.DeleteChannel:
      w.u16(m.channelId);
      break;
    case Op.EditChannel:
      w.u16(m.channelId).str(m.name).str(m.topic).u16(m.maxClients);
      break;
    case Op.ChatSend:
      w.u8(m.scope).u16(m.targetId).str(m.text);
      break;
    case Op.SetSelfState:
      w.u8(m.flags);
      if (m.nickname !== undefined) w.str(m.nickname);
      break;
    case Op.KickClient:
      w.u16(m.clientId).str(m.reason);
      break;
    case Op.BanClient:
      w.u16(m.clientId).str(m.reason).u32(m.minutes);
      break;
    case Op.MoveClient:
      w.u16(m.clientId).u16(m.channelId);
      break;
    case Op.SetClientGroup:
      w.u16(m.clientId).u8(m.group);
      break;
    case Op.SetGroupDef:
      w.u8(m.group).str(m.name).str(m.icon).str(m.color);
      break;
    case Op.BotCommand:
      w.str(m.command);
      w.u16(m.args.length);
      for (const arg of m.args) w.str(arg);
      break;
  }
  return w.finish();
}

/** Lanca se o frame for invalido - quem chama deve derrubar a conexao. */
export function decodeClientMessage(frame: Uint8Array): ClientMessage {
  const r = new Reader(frame);
  if (r.u8() !== FrameKind.Control) throw new Error('frame de controle esperado');
  const t = r.u8() as ClientMessage['t'];
  switch (t) {
    case Op.Hello:
      return {
        t,
        version: r.u16(),
        nickname: r.str(),
        password: r.str(),
        publicKey: r.bytes(),
        platform: r.str(),
      };
    case Op.Auth:
      return { t, signature: r.bytes() };
    case Op.Ping:
      return { t, stamp: r.f64() };
    case Op.JoinChannel:
      return { t, channelId: r.u16(), password: r.str() };
    case Op.CreateChannel:
      return { t, name: r.str(), parentId: r.u16(), maxClients: r.u16(), password: r.str() };
    case Op.DeleteChannel:
      return { t, channelId: r.u16() };
    case Op.EditChannel:
      return { t, channelId: r.u16(), name: r.str(), topic: r.str(), maxClients: r.u16() };
    case Op.ChatSend:
      return { t, scope: r.u8() as ChatScope, targetId: r.u16(), text: r.str() };
    case Op.SetSelfState: {
      const flags = r.u8();
      const nickname = r.remaining > 0 ? r.str() : undefined;
      return { t, flags, ...(nickname !== undefined ? { nickname } : {}) };
    }
    case Op.KickClient:
      return { t, clientId: r.u16(), reason: r.str() };
    case Op.BanClient:
      return { t, clientId: r.u16(), reason: r.str(), minutes: r.u32() };
    case Op.MoveClient:
      return { t, clientId: r.u16(), channelId: r.u16() };
    case Op.SetClientGroup:
      return { t, clientId: r.u16(), group: r.u8() as Group };
    case Op.SetGroupDef:
      return { t, group: r.u8() as Group, name: r.str(), icon: r.str(), color: r.str() };
    case Op.BotCommand:
      return { t, command: r.str(), args: Array.from({ length: r.u16() }, () => r.str()) };
    default:
      throw new Error(`opcode desconhecido do cliente: ${t}`);
  }
}

// ------------------------------------------------------- servidor -> cliente --

export function encodeServerMessage(m: ServerMessage): Uint8Array {
  const w = new Writer(256).u8(FrameKind.Control).u8(m.t);
  switch (m.t) {
    case Op.Challenge:
      w.bytes(m.nonce);
      break;
    case Op.Welcome:
      w
        .u16(m.clientId)
        .u16(m.serverId)
        .str(m.serverName)
        .str(m.motd)
        .u8(m.group)
        .bytes(m.voiceToken)
        .u16(m.wtPort)
        .bytes(m.wtCertHash);
      break;
    case Op.Pong:
      w.f64(m.stamp);
      break;
    case Op.Failure:
      w.u16(m.code).str(m.message);
      break;
    case Op.Snapshot:
      w.list(m.channels, writeChannel).list(m.clients, writeClient);
      break;
    case Op.ChannelAdd:
    case Op.ChannelUpdate:
      writeChannel(w, m.channel);
      break;
    case Op.ChannelRemove:
      w.u16(m.channelId);
      break;
    case Op.ClientAdd:
      writeClient(w, m.client);
      break;
    case Op.ClientRemove:
      w.u16(m.clientId).u8(m.reason);
      break;
    case Op.ClientMove:
      w.u16(m.clientId).u16(m.channelId);
      break;
    case Op.ClientState:
      w.u16(m.clientId).u8(m.flags);
      break;
    case Op.ChatDeliver:
      w.u8(m.scope).u16(m.senderId).u16(m.targetId).str(m.senderName).str(m.text).f64(m.stamp);
      break;
    case Op.GroupDefs:
      w.list(m.groups, writeGroupDef);
      break;
    case Op.BotCommandResult:
      w.u8(m.success ? 1 : 0).str(m.message);
      // data omitted for simplicity - could be extended
      break;
  }
  return w.finish();
}

export function decodeServerMessage(frame: Uint8Array): ServerMessage {
  const r = new Reader(frame);
  if (r.u8() !== FrameKind.Control) throw new Error('frame de controle esperado');
  const t = r.u8() as ServerMessage['t'];
  switch (t) {
    case Op.Challenge:
      return { t, nonce: r.bytes() };
    case Op.Welcome:
      return {
        t,
        clientId: r.u16(),
        serverId: r.u16(),
        serverName: r.str(),
        motd: r.str(),
        group: r.u8() as Group,
        voiceToken: r.bytes(),
        wtPort: r.u16(),
        wtCertHash: r.bytes(),
      };
    case Op.Pong:
      return { t, stamp: r.f64() };
    case Op.Failure:
      return { t, code: r.u16() as FailureCode, message: r.str() };
    case Op.Snapshot:
      return { t, channels: r.list(readChannel), clients: r.list(readClient) };
    case Op.ChannelAdd:
    case Op.ChannelUpdate:
      return { t, channel: readChannel(r) };
    case Op.ChannelRemove:
      return { t, channelId: r.u16() };
    case Op.ClientAdd:
      return { t, client: readClient(r) };
    case Op.ClientRemove:
      return { t, clientId: r.u16(), reason: r.u8() as RemoveReason };
    case Op.ClientMove:
      return { t, clientId: r.u16(), channelId: r.u16() };
    case Op.ClientState:
      return { t, clientId: r.u16(), flags: r.u8() };
    case Op.ChatDeliver:
      return {
        t,
        scope: r.u8() as ChatScope,
        senderId: r.u16(),
        targetId: r.u16(),
        senderName: r.str(),
        text: r.str(),
        stamp: r.f64(),
      };
    case Op.GroupDefs:
      return { t, groups: r.list(readGroupDef) };
    case Op.BotCommandResult:
      return { t, success: r.u8() === 1, message: r.str(), data: undefined };
    default:
      throw new Error(`opcode desconhecido do servidor: ${t}`);
  }
}
