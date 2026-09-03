/** Constantes e formatos compartilhados entre servidor e cliente. */

/**
 * 12: matriz de permissoes por acao configuravel pelo owner.
 * 11: PlayerInfo (voc/level/online) por fingerprint via bot Rubinot.
 * 10: 8 tiers de grupo (Visitante..Leader) e descricao por fingerprint.
 * 9: sinalizacao WebRTC para compartilhamento de tela/janela.
 * 8: read receipts para mensagens privadas.
 * 7: guilds amigas/inimigas configuraveis (varias por lado).
 * 6: alertas do bot com toggles amigo/inimigo.
 * 5: configuracao do bot Rubinot editavel a partir do cliente (owner).
 * 4: claims de respawn por servidor.
 * 3: servidores virtuais, identidade por chave publica e grupos.
 * 2: Welcome passou a anunciar o canal de voz por WebTransport.
 * 13: Welcome passou a anunciar um hostname de voz separado (voice edge).
 */
export const PROTOCOL_VERSION = 13;

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
  ChatRead = 0x77,
  ScreenSignal = 0x78,
  SetClientDescription = 0x79,
  SetPermission = 0x7a,

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
  ChatReadDeliver = 0xc3,
  ScreenSignalDeliver = 0xc4,
  PlayerInfoBatch = 0xc5,
  Permissions = 0xc6,
}

export enum BotControlAction {
  Start = 0,
  Stop = 1,
  Test = 2,
  AddHunted = 3,
  RemoveHunted = 4,
  AddFriendGuild = 5,
  RemoveFriendGuild = 6,
  AddEnemyGuild = 7,
  RemoveEnemyGuild = 8,
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
  /** Mostrar morte de jogador da hunted list (nao esta na guild). */
  alertEnemyDeath: boolean;
  /** Mostrar morte de jogador da guild configurada. */
  alertFriendDeath: boolean;
  /** Mostrar levelup de jogador da guild. */
  alertFriendLevelUp: boolean;
  /** Mostrar levelup de jogador da hunted list. */
  alertEnemyLevelUp: boolean;
  /** Mostrar login de inimigo. */
  alertEnemyOnline: boolean;
  /** Mostrar logout de inimigo. */
  alertEnemyOffline: boolean;
  hunted: string[];
  friends: string[];
  friendGuilds: string[];
  enemyGuilds: string[];
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
 *
 * Nomes internos (Guest/Moderator/Admin/Owner) foram mantidos para nao
 * quebrar todo o codigo que checa Group.Moderator etc. Os valores mudaram:
 * agora ha 8 tiers entre eles, com espacos para "Spy/Membro/Elite/Suporte"
 * organizacionalmente entre Visitante e Moderador.
 */
export enum Group {
  Guest = 0,       // Visitante
  Spy = 1,
  Member = 2,      // Membro
  Elite = 3,
  Support = 4,     // Suporte
  Moderator = 5,   // Moderador
  Admin = 6,
  Owner = 7,       // Leader / Dono
}

/** Nome legivel do grupo, usado na interface e no painel. */
export const GROUP_NAMES: Record<Group, string> = {
  [Group.Guest]: 'visitante',
  [Group.Spy]: 'spy',
  [Group.Member]: 'membro',
  [Group.Elite]: 'elite',
  [Group.Support]: 'suporte',
  [Group.Moderator]: 'moderador',
  [Group.Admin]: 'admin',
  [Group.Owner]: 'leader',
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
  /** Descricao livre por identidade (ex: "Main: Pedrao Warsz"). Persistida. */
  description: string;
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

/**
 * Info do personagem Tibia associado a uma descricao "Main: <nome>".
 * Preenchido pelo bot Rubinot; retido em cache (level/vocation persistem
 * mesmo quando offline).
 */
export interface PlayerInfo {
  /** Identidade do dono no Vox. */
  fingerprint: string;
  /** Nome do char no jogo (case original). */
  name: string;
  /** EK / ED / MS / RP / MK (ou vazio se desconhecido). */
  vocation: string;
  /** Level atual (0 = desconhecido). */
  level: number;
  online: boolean;
  /** Timestamp da ultima atualizacao. 0 = nunca resolvido. */
  updatedAt: number;
}

export const DEFAULT_GROUP_DEFS: GroupDef[] = [
  { id: Group.Guest, name: 'Visitante', icon: '', color: '' },
  { id: Group.Spy, name: 'Spy', icon: '', color: '#8f8f8f' },
  { id: Group.Member, name: 'Membro', icon: '', color: '#7fd89b' },
  { id: Group.Elite, name: 'Elite', icon: '', color: '#a9c4ff' },
  { id: Group.Support, name: 'Suporte', icon: '', color: '#9edcad' },
  { id: Group.Moderator, name: 'Moderador', icon: '', color: '#f0cd76' },
  { id: Group.Admin, name: 'Admin', icon: '', color: '#e0a040' },
  { id: Group.Owner, name: 'Leader', icon: '', color: '#e8a33d' },
];

/**
 * Template Tibia: categorias (canais-pai) com canais reais dentro,
 * espelhando o layout tipico de guild/war no TS3.
 */
export interface TemplateCategory {
  name: string;
  topic: string;
  children: { name: string; topic: string }[];
}

export const TIBIA_TEMPLATE: readonly TemplateCategory[] = [
  {
    name: 'CHANELS',
    topic: 'Canais principais / war',
    children: [
      { name: 'TAPETA DARASHIA FAST', topic: '' },
      { name: 'Channel Vermelho', topic: '' },
      { name: 'Channel 01 WAR CHANNEL', topic: 'War channel' },
      { name: 'Channel 02', topic: '' },
      { name: 'Channel 03', topic: '' },
      { name: 'Channel 04', topic: '' },
      { name: 'Channel 05', topic: '' },
      { name: 'Channel 06', topic: '' },
      { name: 'Channel 07', topic: '' },
      { name: 'Channel 08', topic: '' },
      { name: 'Channel 09', topic: '' },
      { name: 'Channel 10', topic: '' },
      { name: 'Channel 11', topic: '' },
      { name: 'Channel 12', topic: '' },
      { name: 'Channel 13', topic: '' },
      { name: 'Channel 14', topic: '' },
      { name: 'Channel 15', topic: '' },
      { name: 'Channel 16', topic: '' },
      { name: 'Channel 17', topic: '' },
      { name: 'Channel 18', topic: '' },
    ],
  },
  {
    name: "HUNT'S",
    topic: 'Respawns e locais de caca',
    children: [
      { name: 'Rotten Wasteland (North)', topic: '' },
      { name: 'Rotten Wasteland (North-West)', topic: '' },
      { name: 'Rotten Wasteland (South-West)', topic: '' },
      { name: 'Livraria - Energy', topic: '' },
      { name: 'Livraria - Fire', topic: '' },
      { name: 'Livraria - Ice', topic: '' },
      { name: 'Mirrored Nightmare (Thais invert)', topic: '' },
      { name: 'Furious Crater (Cloak)', topic: '' },
      { name: 'Claustrophobic Inferno (Brachio)', topic: '' },
      { name: 'Piranha (North)', topic: '' },
      { name: 'Piranha (South)', topic: '' },
      { name: 'Gnomprona (Carrinho 1)', topic: '' },
      { name: 'Gnomprona (Carrinho 2)', topic: '' },
      { name: 'Gnomprona (Carrinho 3)', topic: '' },
      { name: 'Putrefactory', topic: '' },
      { name: 'Jaded Roots', topic: '' },
      { name: 'Gloom Pillars', topic: '' },
      { name: 'Darklight Core', topic: '' },
    ],
  },
  {
    name: 'PRIVATE',
    topic: 'Canais privados',
    children: [
      { name: 'Private 02', topic: '' },
      { name: 'Private 03', topic: '' },
      { name: 'Private 04', topic: '' },
      { name: 'Private 05', topic: '' },
    ],
  },
];

/** Raiz da arvore de canais / "nenhum canal". */
export const NO_CHANNEL = 0;

/**
 * Todas as acoes que podem ser gate por grupo. Owner ajusta o grupo minimo
 * pra cada uma via Op.SetPermission. Ordem numerica importa (serializacao).
 */
export enum PermissionAction {
  CreateTempChannel = 0,
  CreatePermanentChannel = 1,
  EditChannel = 2,
  DeleteChannel = 3,
  Kick = 4,
  Move = 5,
  Ban = 6,
  SetGroup = 7,
  SetOtherDescription = 8,
  BotPoke = 20,
  BotMassPoke = 21,
  BotPush = 22,
  BotMassPush = 23,
  BotKick = 24,
  BotMassKick = 25,
  BotBan = 26,
  BotBanList = 27,
  BotUnban = 28,
  BotAfk = 29,
  BotMute = 30,
  BotUnmute = 31,
  BotModerate = 32,
  BotVoice = 33,
  BotDevoice = 34,
  BotHunt = 35,
  BotUnhunt = 36,
  BotHunted = 37,
}

/** Rotulos user-friendly (usados no dropdown do painel). */
export const PERMISSION_LABELS: Record<PermissionAction, string> = {
  [PermissionAction.CreateTempChannel]: 'Criar canal temporário',
  [PermissionAction.CreatePermanentChannel]: 'Criar canal permanente',
  [PermissionAction.EditChannel]: 'Editar canal',
  [PermissionAction.DeleteChannel]: 'Deletar canal',
  [PermissionAction.Kick]: 'Expulsar (kick)',
  [PermissionAction.Move]: 'Mover usuário',
  [PermissionAction.Ban]: 'Banir',
  [PermissionAction.SetGroup]: 'Alterar grupo de outros',
  [PermissionAction.SetOtherDescription]: 'Editar descrição de outros',
  [PermissionAction.BotPoke]: 'Bot: poke',
  [PermissionAction.BotMassPoke]: 'Bot: masspoke',
  [PermissionAction.BotPush]: 'Bot: push',
  [PermissionAction.BotMassPush]: 'Bot: masspush',
  [PermissionAction.BotKick]: 'Bot: kick',
  [PermissionAction.BotMassKick]: 'Bot: masskick',
  [PermissionAction.BotBan]: 'Bot: ban',
  [PermissionAction.BotBanList]: 'Bot: banlist',
  [PermissionAction.BotUnban]: 'Bot: unban',
  [PermissionAction.BotAfk]: 'Bot: afk toggle',
  [PermissionAction.BotMute]: 'Bot: mute',
  [PermissionAction.BotUnmute]: 'Bot: unmute',
  [PermissionAction.BotModerate]: 'Bot: moderate canal',
  [PermissionAction.BotVoice]: 'Bot: voice',
  [PermissionAction.BotDevoice]: 'Bot: devoice',
  [PermissionAction.BotHunt]: 'Bot: hunt',
  [PermissionAction.BotUnhunt]: 'Bot: unhunt',
  [PermissionAction.BotHunted]: 'Bot: ver hunted list',
};

/** Padroes conservadores. Owner pode restringir/afrouxar via UI. */
export const DEFAULT_PERMISSIONS: Record<PermissionAction, Group> = {
  [PermissionAction.CreateTempChannel]: Group.Elite,
  [PermissionAction.CreatePermanentChannel]: Group.Moderator,
  [PermissionAction.EditChannel]: Group.Moderator,
  [PermissionAction.DeleteChannel]: Group.Moderator,
  [PermissionAction.Kick]: Group.Moderator,
  [PermissionAction.Move]: Group.Moderator,
  [PermissionAction.Ban]: Group.Admin,
  [PermissionAction.SetGroup]: Group.Admin,
  [PermissionAction.SetOtherDescription]: Group.Moderator,
  [PermissionAction.BotPoke]: Group.Guest,
  [PermissionAction.BotMassPoke]: Group.Moderator,
  [PermissionAction.BotPush]: Group.Moderator,
  [PermissionAction.BotMassPush]: Group.Admin,
  [PermissionAction.BotKick]: Group.Moderator,
  [PermissionAction.BotMassKick]: Group.Admin,
  [PermissionAction.BotBan]: Group.Admin,
  [PermissionAction.BotBanList]: Group.Admin,
  [PermissionAction.BotUnban]: Group.Admin,
  [PermissionAction.BotAfk]: Group.Admin,
  [PermissionAction.BotMute]: Group.Moderator,
  [PermissionAction.BotUnmute]: Group.Moderator,
  [PermissionAction.BotModerate]: Group.Moderator,
  [PermissionAction.BotVoice]: Group.Moderator,
  [PermissionAction.BotDevoice]: Group.Moderator,
  [PermissionAction.BotHunt]: Group.Moderator,
  [PermissionAction.BotUnhunt]: Group.Moderator,
  [PermissionAction.BotHunted]: Group.Guest,
};

/** Entrada serializada de permissao no wire. */
export interface PermissionEntry {
  action: PermissionAction;
  minGroup: Group;
}
