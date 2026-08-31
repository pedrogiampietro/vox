/** Configuracao do servidor, toda por variavel de ambiente. */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

function str(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export const config = {
  host: str('VOX_HOST', '0.0.0.0'),
  port: num('VOX_PORT', 9987),

  serverName: str('VOX_NAME', 'Servidor Vox'),
  motd: str('VOX_MOTD', 'Bem-vindo.'),
  /** Vazio = servidor aberto. */
  password: str('VOX_PASSWORD', ''),

  maxClients: num('VOX_MAX_CLIENTS', 128),
  /**
   * Conexoes simultaneas por endereco IP. Segura o caso trivial de um host so
   * abrir mil sockets; 0 desliga. Cuidado ao baixar: uma casa inteira atras de
   * NAT compartilha um IP.
   */
  maxPerIp: num('VOX_MAX_PER_IP', 8),

  /** Sem ping do cliente por esse tempo, a conexao cai. */
  timeoutMs: num('VOX_TIMEOUT_MS', 30_000),

  /** Tetos anti-abuso, por segundo e por conexao. */
  voicePacketsPerSecond: num('VOX_VOICE_RATE', 120),
  controlMessagesPerSecond: num('VOX_CONTROL_RATE', 40),

  /** Onde os canais permanentes sao gravados. */
  dataDir: str('VOX_DATA_DIR', 'data'),

  /**
   * TLS direto no Node. Deixe vazio quando houver um proxy reverso na frente
   * (Caddy, nginx) - e o caminho recomendado, porque renova certificado sozinho.
   *
   * Isto nao e luxo: o navegador so libera o microfone em contexto seguro, e
   * localhost e a unica excecao. Servidor remoto em HTTP puro = cliente web sem
   * captura de audio, sem mensagem de erro util.
   */
  tlsCert: str('VOX_TLS_CERT', ''),
  tlsKey: str('VOX_TLS_KEY', ''),

  /**
   * Ligue quando houver proxy reverso: o IP do cliente passa a vir do
   * X-Forwarded-For em vez do socket. Com isso desligado atras de um proxy,
   * todo mundo vira o mesmo IP e o limite por IP derruba o servidor inteiro.
   */
  trustProxy: bool('VOX_TRUST_PROXY', false),
} as const;

export const tlsEnabled = config.tlsCert !== '' && config.tlsKey !== '';
