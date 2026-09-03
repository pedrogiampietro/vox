/**
 * Configuracao do servidor, toda por variavel de ambiente.
 *
 * Le .env na raiz do monorepo se a variavel nao estiver setada.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { VoiceEdge } from '@vox/protocol';
const __dirname = dirname(fileURLToPath(import.meta.url));

const wtPort = num('VOX_WT_PORT', num('VOX_PORT', 9987));

for (const base of [join(process.cwd(), '.env'), join(__dirname, '..', '..', '..', '.env')]) {
  try {
    const env = readFileSync(base, 'utf8');
    for (const line of env.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) {
        const key = line.slice(0, eq);
        if (/^[A-Z_][A-Z0-9_]*$/.test(key) && !(key in process.env)) {
          process.env[key] = line.slice(eq + 1).trim();
        }
      }
    }
    break;
  } catch { /* tenta o proximo caminho */ }
}

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

/**
 * Lista no formato `regiao=host:porta,regiao2=host:porta`.
 * O formato simples deixa a configuração legível no .env e permite que o
 * cliente escolha a primeira rota QUIC que responder.
 */
function parseVoiceEdges(raw: string, fallbackHost: string, fallbackPort: number): VoiceEdge[] {
  const values = raw.split(',').map((item) => item.trim()).filter(Boolean);
  if (values.length === 0 && fallbackHost) {
    return [{ host: fallbackHost, port: fallbackPort, region: regionFromHost(fallbackHost), certHash: new Uint8Array(0) }];
  }

  const edges: VoiceEdge[] = [];
  for (const value of values) {
    const eq = value.indexOf('=');
    const region = eq >= 0 ? value.slice(0, eq).trim() : '';
    const endpoint = (eq >= 0 ? value.slice(eq + 1) : value).trim();
    const colon = endpoint.lastIndexOf(':');
    const host = (colon > 0 ? endpoint.slice(0, colon) : endpoint).trim();
    const port = colon > 0 ? Number(endpoint.slice(colon + 1)) : fallbackPort;
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    edges.push({ host, port, region: region || regionFromHost(host), certHash: new Uint8Array(0) });
  }
  return edges;
}

function regionFromHost(host: string): string {
  const value = host.toLowerCase();
  if (value.includes('sp') || value.includes('sao-paulo') || value.includes('sao_paulo')) return 'São Paulo';
  if (value.includes('dallas') || value.includes('dal')) return 'Dallas';
  return host;
}

const voiceEdgeHost = str('VOX_VOICE_EDGE_HOST', '');
const voiceEdgePort = num('VOX_VOICE_EDGE_PORT', 9987);
const voiceEdges = parseVoiceEdges(str('VOX_VOICE_EDGES', ''), voiceEdgeHost, voiceEdgePort);

export const config = {
  host: str('VOX_HOST', '0.0.0.0'),
  port: num('VOX_PORT', 9987),

  serverName: str('VOX_NAME', 'Servidor v0x'),
  /** Dominio base usado para resolver subdominios de servidores. */
  baseDomain: str('VOX_BASE_DOMAIN', 'v0x.online'),
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

  /** Move para canal AFK ao mutar mic + fone. */
  afkEnabled: bool('VOX_AFK_ENABLED', true),
  /** Nome do canal AFK (criado automaticamente se nao existir). */
  afkChannelName: str('VOX_AFK_CHANNEL', 'AFK'),

  /** Onde os canais permanentes sao gravados. */
  dataDir: str('VOX_DATA_DIR', 'data'),

  /** Diretorio no disco cujos arquivos sao servidos em /icons/<nome>. */
  iconsDir: str('VOX_ICONS_DIR', '/root/icons'),

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
   * WebTransport (voz em datagramas sobre QUIC). Porta UDP - pode ser a mesma
   * da porta TCP, sao espacos separados.
   */
  wtPort,
  /** Ultima porta do intervalo reservado para os listeners por hostname. */
  wtPortMax: num('VOX_WT_PORT_MAX', wtPort + 99),
  /**
   * Endereco do socket QUIC. "0.0.0.0" so escuta IPv4, e como quase todo host
   * moderno resolve para IPv6 primeiro (inclusive "localhost"), o cliente bate
   * num socket que nao existe e cai de volta para o WebSocket sem explicacao.
   * Por isso "escutar em tudo" vira "::", que e dual-stack.
   */
  wtHost: str('VOX_WT_HOST', '') || (str('VOX_HOST', '0.0.0.0') === '0.0.0.0'
    ? '::'
    : str('VOX_HOST', '0.0.0.0')),
  /** Certificado do QUIC. Vazio herda o do TLS; sem nenhum, sem WebTransport. */
  wtCert: str('VOX_WT_CERT', '') || str('VOX_TLS_CERT', ''),
  wtKey: str('VOX_WT_KEY', '') || str('VOX_TLS_KEY', ''),
  /**
   * Raiz do armazenamento de certificados do Caddy. Quando vazio, o Vox
   * tenta descobrir esta raiz a partir do caminho de VOX_WT_CERT.
   */
  wtCertDir: str('VOX_WT_CERT_DIR', ''),
  /**
   * Publica o SHA-256 do certificado no Welcome, para o navegador aceitar um
   * certificado autoassinado via serverCertificateHashes. So em
   * desenvolvimento: em producao o certificado e valido e isso nao ajuda.
   */
  wtPublishHash: bool('VOX_WT_PUBLISH_HASH', false),

  /** Hostname publico do edge de voz. Vazio = QUIC na propria VPS. */
  voiceEdgeHost,
  /** Porta UDP do edge anunciado no Welcome. */
  voiceEdgePort,
  /** Segredo compartilhado usado pelo link privado edge -> origem. */
  voiceEdgeSecret: str('VOX_VOICE_EDGE_SECRET', ''),
  /** Candidatos `regiao=host:porta` para seleção automática no cliente. */
  voiceEdges,

  /**
   * Senha do painel de administracao. Vazia desliga o painel inteiro - e o
   * padrao, porque um painel aberto e pior que nenhum painel.
   */
  adminPassword: str('VOX_ADMIN_PASSWORD', ''),
  /** Validade da sessao do painel. */
  adminSessionMs: num('VOX_ADMIN_SESSION_MS', 12 * 60 * 60 * 1000),

  /**
   * Ligue quando houver proxy reverso: o IP do cliente passa a vir do
   * X-Forwarded-For em vez do socket. Com isso desligado atras de um proxy,
   * todo mundo vira o mesmo IP e o limite por IP derruba o servidor inteiro.
   */
  trustProxy: bool('VOX_TRUST_PROXY', false),
} as const;

export const tlsEnabled = config.tlsCert !== '' && config.tlsKey !== '';
export const adminEnabled = config.adminPassword !== '';
