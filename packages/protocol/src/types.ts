/** Constantes e formatos compartilhados entre servidor e cliente. */

/**
 * 5: configuracao do bot Rubinot editavel a partir do cliente (owner).
 * 4: claims de respawn por servidor.
 * 3: servidores virtuais, identidade por chave publica e grupos.
 * 2: Welcome passou a anunciar o canal de voz por WebTransport.
 */
export const PROTOCOL_VERSION = 5;

/** Desafio assinado no handshake, para provar a posse da chave privada. */
export const CHALLENGE_BYTES = 32;

/** Impressao digital da identidade: SHA-256 da chave publica, em hex. */
export const FINGERPRINT_CHARS = 64;

/** Segredo que liga a sessao WebTransport a sessao de controle. */
export const VOICE_TOKEN_BYTES = 16;

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
  Auth = 0x03,
  JoinChannel = 0x10,
  CreateChannel = 0x11,
  DeleteChannel = 0x12,
  EditChannel = 0x13,
  ChatSend = 0x20,
  SetSelfState = 0x30,
  KickClient = 0x50,
  BanClient = 0x51,
  MoveClient = 0x52,
  SetClientGroup = 0x53,
  SetGroupDef = 0x54,
  BotCommand = 0x60,
  ClaimResp = 0x70,
  ReleaseResp = 0x71,
  JoinRespQueue = 0x72,
  LeaveRespQueue = 0x73,
  GetBotState = 0x74,
  UpdateBotConfig = 0x75,
  BotControl = 0x76,

  // servidor -> cliente
  Welcome = 0x81,
  Pong = 0x82,
  Failure = 0x83,
  Snapshot = 0x84,
  Challenge = 0x85,
  ChannelAdd = 0x90,
  ChannelRemove = 0x91,
  ChannelUpdate = 0x92,
  ClientAdd = 0xa0,
  ClientRemove = 0xa1,
  ClientMove = 0xa2,
  ClientState = 0xa3,
  ChatDeliver = 0xb0,
  GroupDefs = 0xb1,
  BotCommandResult = 0xc0,
  RespClaims = 0xc1,
  BotState = 0xc2,
}

export enum BotControlAction {
  Start = 0,
  Stop = 1,
  Test = 2,
  AddHunted = 3,
  RemoveHunted = 4,
}

/** Estado observavel do bot Rubinot, enviado ao owner que entra. */
export interface BotStateInfo {
  world: string;
  guildName: string;
  channelName: string;
  intervalMs: number;
  enabled: boolean;
  globalDeaths: boolean;
  globalKills: boolean;
  globalLevelMin: number;
  summarizePresence: boolean;
  presenceSummaryMs: number;
  hunted: string[];
  running: boolean;
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
  /** Permissao de voz em canal moderado, concedida por moderador. */
  HasVoice: 1 << 4,
} as const;

export const ChannelFlags = {
  None: 0,
  /** Exige senha para entrar. */
  Password: 1 << 0,
  /** Nao e removido quando fica vazio. */
  Permanent: 1 << 1,
  /** Canal de entrada padrao do servidor. */
  Default: 1 << 2,
  /** Canal moderado: so Moderator+ e quem tem HasVoice podem falar. */
  Moderated: 1 << 3,
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
  BadSignature = 10,
  Banned = 11,
  ServerNotFound = 12,
}

/**
 * Grupos, em ordem crescente de poder. Comparacao numerica basta: quem tem
 * grupo maior ou igual ao exigido pode agir - e ninguem age sobre alguem de
 * grupo maior ou igual ao seu.
 */
export enum Group {
  Guest = 0,
  Moderator = 1,
  Admin = 2,
  Owner = 3,
}

/** Nome legivel do grupo, usado na interface e no painel. */
export const GROUP_NAMES: Record<Group, string> = {
  [Group.Guest]: 'convidado',
  [Group.Moderator]: 'moderador',
  [Group.Admin]: 'administrador',
  [Group.Owner]: 'dono',
};

export enum RemoveReason {
  Disconnected = 0,
  Timeout = 1,
  Kicked = 2,
  Banned = 3,
  ServerClosed = 4,
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
  group: Group;
  /** Identidade estavel entre sessoes; vazio se o cliente nao apresentou uma. */
  fingerprint: string;
  /** Timestamp Unix (ms) de quando conectou. 0 = desconhecido. */
  connectedAt: number;
  /** Plataforma do cliente (ex: "Web", "Desktop"). Vazio = desconhecido. */
  platform: string;
}

/** Definicao visual de um grupo. */
export interface GroupDef {
  id: Group;
  name: string;
  /** Data URI do icone (PNG/JPG). Vazio = sem icone. */
  icon: string;
  /** Cor hex para o nome. Vazio = cor padrao. */
  color: string;
}

export interface RespClaimInfo {
  id: number;
  respawn: string;
  note: string;
  ownerId: number;
  ownerName: string;
  claimedAt: number;
  expiresAt: number;
  queue: RespQueueEntry[];
}

export interface RespQueueEntry {
  clientId: number;
  name: string;
}

export const DEFAULT_GROUP_DEFS: GroupDef[] = [
  { id: Group.Guest, name: 'Convidado', icon: '', color: '' },
  { id: Group.Moderator, name: 'Moderador', icon: '', color: '' },
  { id: Group.Admin, name: 'Administrador', icon: '', color: '#e0a040' },
  { id: Group.Owner, name: 'Dono', icon: '', color: '#e8a33d' },
];

/** Raiz da arvore de canais / "nenhum canal". */
export const NO_CHANNEL = 0;
