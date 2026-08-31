/** Constantes e formatos compartilhados entre servidor e cliente. */

export const PROTOCOL_VERSION = 1;

/** Primeiro byte de todo frame, em qualquer transporte. */
export enum FrameKind {
  Voice = 0x00,
  Control = 0x01,
}

/** Opcode do segundo byte de um frame de controle. */
export enum Op {
  // cliente -> servidor
  Hello = 0x01,
  Ping = 0x02,
  JoinChannel = 0x10,
  CreateChannel = 0x11,
  DeleteChannel = 0x12,
  EditChannel = 0x13,
  ChatSend = 0x20,
  SetSelfState = 0x30,

  // servidor -> cliente
  Welcome = 0x81,
  Pong = 0x82,
  Failure = 0x83,
  Snapshot = 0x84,
  ChannelAdd = 0x90,
  ChannelRemove = 0x91,
  ChannelUpdate = 0x92,
  ClientAdd = 0xa0,
  ClientRemove = 0xa1,
  ClientMove = 0xa2,
  ClientState = 0xa3,
  ChatDeliver = 0xb0,
}

/** Bits de estado do cliente (auto-declarado, o servidor apenas replica). */
export const ClientFlags = {
  None: 0,
  /** Microfone desligado pelo proprio usuario. */
  MutedMic: 1 << 0,
  /** Saida de audio desligada (implica microfone mudo). */
  MutedSpeakers: 1 << 1,
  /** Ausente. */
  Away: 1 << 2,
  /** Sem dispositivo de captura disponivel. */
  NoInput: 1 << 3,
} as const;

export const ChannelFlags = {
  None: 0,
  /** Exige senha para entrar. */
  Password: 1 << 0,
  /** Nao e removido quando fica vazio. */
  Permanent: 1 << 1,
  /** Canal de entrada padrao do servidor. */
  Default: 1 << 2,
} as const;

/** Bits do cabecalho de voz. */
export const VoiceFlags = {
  None: 0,
  /** Ultimo pacote de uma rajada de fala; o receptor pode encerrar o buffer. */
  EndOfTalk: 1 << 0,
} as const;

export enum ChatScope {
  Channel = 0,
  Server = 1,
  Private = 2,
}

export enum FailureCode {
  Unknown = 0,
  VersionMismatch = 1,
  BadPassword = 2,
  NicknameTaken = 3,
  ServerFull = 4,
  ChannelFull = 5,
  ChannelNotFound = 6,
  NotPermitted = 7,
  RateLimited = 8,
  Malformed = 9,
}

export enum RemoveReason {
  Disconnected = 0,
  Timeout = 1,
  Kicked = 2,
  Banned = 3,
}

export interface ChannelInfo {
  id: number;
  parentId: number;
  order: number;
  name: string;
  topic: string;
  maxClients: number;
  flags: number;
}

export interface ClientInfo {
  id: number;
  channelId: number;
  nickname: string;
  flags: number;
}

/** Raiz da arvore de canais / "nenhum canal". */
export const NO_CHANNEL = 0;
