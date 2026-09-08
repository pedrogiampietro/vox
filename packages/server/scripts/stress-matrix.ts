/**
 * Matriz repetivel de capacidade para comparar uma ou mais VPS.
 *
 * Cada caso usa o stress.ts real, portanto conclui o handshake do Vox e gera
 * voz sintetica. O resultado e de protocolo/voz. Rubinot e outras cargas
 * externas devem ser avaliados em uma rodada separada; o Jukebox pode ser
 * ligado ou desligado com VOX_JUKEBOX_ENABLED.
 *
 * Exemplos (PowerShell):
 *   npm run stress:matrix -- --duration 10
 *   npm run stress:matrix -- --target hostinger=wss://server-1.v0x.online/vox
 *   npm run stress:matrix -- --target contabo=wss://contabo.v0x.online/vox --duration 30
 *
 * Para destinos remotos, STRESS_CONFIRM=1 continua obrigatorio. O token
 * administrativo e herdado de STRESS_ADMIN_TOKEN e nunca e salvo no relatorio.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

type Case = {
  name: string;
  clients: number;
  speakers: number;
  channels: number;
};

type Target = {
  name: string;
  url: string;
};

type StressSummary = {
  target: string;
  clientsRequested: number;
  clientsActive: number;
  socketsOpen: number;
  voiceSent: number;
  voiceReceived: number;
  rttMs: { p50: number; p95: number; p99: number; samples: number };
  voiceTransports?: { ws: number; wsDedicated?: number; quic: number };
  failures: string[];
  adminRuntime: {
    processCpuPercent: number;
    hostCpuPercent: number;
    eventLoopLagP95Ms: number;
    memory: { rssBytes: number; systemUsedPercent: number };
    traffic: { inboundKbps: number; outboundKbps: number };
  } | null;
  pass: boolean;
};

type CaseResult = Case & {
  target: string;
  summary: StressSummary | null;
  exitCode: number;
};

const DEFAULT_URL = process.env.VOX_URL ?? 'ws://127.0.0.1:9987/vox';
const options = parseOptions();

async function main(): Promise<void> {
  const reportDir = resolve(options.outputDir);
  mkdirSync(reportDir, { recursive: true });
  const results: CaseResult[] = [];

  console.log(`matriz: ${options.targets.map((target) => `${target.name}=${target.url}`).join(' · ')}`);
  console.log(`casos: ${options.cases.map((item) => `${item.name} (${item.clients} clientes/${item.speakers} falantes)`).join(' · ')}`);
  console.log(`duracao por caso: ${options.durationSec}s · voz sintetica · Rubinot ausente · Jukebox ${process.env.VOX_JUKEBOX_ENABLED === '0' ? 'desligado' : 'ligado'}`);
  console.log(`perfil: realista · transporte: ${options.voiceTransport}`);

  for (const target of options.targets) {
    for (const item of options.cases) {
      const file = join(reportDir, `${safeName(target.name)}-${safeName(item.name)}.json`);
      console.log(`\n=== ${target.name} / ${item.name} ===`);
      const exitCode = await runCase(target, item, file);
      let summary: StressSummary | null = null;
      try {
        summary = JSON.parse(readFileSync(file, 'utf8')) as StressSummary;
      } catch {
        // O output textual do stress continua disponivel; apenas faltou o JSON.
      }
      results.push({ ...item, target: target.name, summary, exitCode });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    durationSec: options.durationSec,
    voice: {
      bytes: Number(process.env.STRESS_VOICE_BYTES ?? 96),
      intervalMs: Number(process.env.STRESS_VOICE_INTERVAL_MS ?? 20),
      transport: options.voiceTransport,
    },
    note: `Capacidade de protocolo/voz sintetica; Rubinot ausente; Jukebox ${process.env.VOX_JUKEBOX_ENABLED === '0' ? 'desligado' : 'ligado'}.`,
    results,
  };
  const reportFile = join(reportDir, 'report.json');
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  printReport(report);
  if (results.some((result) => result.exitCode !== 0 || result.summary?.pass === false)) {
    process.exitCode = 1;
  }
}

function runCase(target: Target, item: Case, outputFile: string): Promise<number> {
  const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');
  const child = spawn(process.execPath, [
    tsxCli,
    'packages/server/scripts/stress.ts',
    '--url',
    target.url,
    '--clients',
    String(item.clients),
    '--speakers',
    String(item.speakers),
    '--channels',
    String(item.channels),
    '--duration',
    String(options.durationSec),
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      STRESS_JSON_OUT: outputFile,
      STRESS_VOICE_PROFILE: 'realistic',
      STRESS_VOICE_TRANSPORT: options.voiceTransport,
    },
    stdio: 'inherit',
    windowsHide: true,
  });
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolvePromise(code ?? (signal ? 1 : 0)));
  });
}

function printReport(report: { results: CaseResult[] }): void {
  console.log('\n=== resumo da matriz ===');
  console.log('alvo | caso | ativos | RTT p95 | CPU processo | RSS | banda saida | resultado');
  for (const result of report.results) {
    const summary = result.summary;
    if (!summary) {
      console.log(`${result.target} | ${result.name} | sem resumo | processo ${result.exitCode}`);
      continue;
    }
    const runtime = summary.adminRuntime;
    console.log([
      result.target,
      result.name,
      `${summary.clientsActive}/${summary.clientsRequested}`,
      `${summary.rttMs.p95.toFixed(0)}ms`,
      runtime ? `${runtime.processCpuPercent.toFixed(1)}%` : 'n/d',
      runtime ? formatBytes(runtime.memory.rssBytes) : 'n/d',
      runtime ? `${runtime.traffic.outboundKbps.toFixed(1)}kbps` : 'n/d',
      summary.pass && result.exitCode === 0 ? 'PASS' : 'FAIL',
    ].join(' | '));
  }
  console.log(`\nrelatorio: ${resolve(options.outputDir, 'report.json')}`);
}

function parseOptions(): { targets: Target[]; cases: Case[]; durationSec: number; outputDir: string; voiceTransport: 'ws' | 'ws-dedicated' | 'quic' | 'auto' } {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Uso: npm run stress:matrix -- [--target nome=WS_URL] [--duration SEC] [--output DIR] [--voice-transport ws|ws-dedicated|quic|auto]');
    console.log('Padrao: 50, 100 e 150 clientes, distribuidos em 2, 4 e 8 canais; use STRESS_ADMIN_TOKEN para CPU/RAM/banda.');
    process.exit(0);
  }
  const targets = values('--target').map(parseTarget);
  return {
    targets: targets.length > 0 ? targets : [{ name: 'local', url: DEFAULT_URL }],
    cases: [
      { name: '50-clientes', clients: 50, speakers: 8, channels: 2 },
      { name: '100-clientes', clients: 100, speakers: 16, channels: 4 },
      { name: '150-clientes', clients: 150, speakers: 24, channels: 8 },
    ],
    durationSec: boundedNumber(value('--duration'), 30, 1, 3600),
    outputDir: value('--output') ?? '.tmp-stress-matrix',
    voiceTransport: parseVoiceTransport(value('--voice-transport') ?? process.env.STRESS_MATRIX_TRANSPORT),
  };
}

function parseVoiceTransport(raw: string | undefined): 'ws' | 'ws-dedicated' | 'quic' | 'auto' {
  if (raw === 'ws' || raw === 'quic' || raw === 'ws-dedicated' || raw === 'dedicated-ws') {
    return raw === 'dedicated-ws' ? 'ws-dedicated' : raw;
  }
  return 'auto';
}

function values(flag: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < process.argv.length; index++) {
    if (process.argv[index] === flag && process.argv[index + 1]) found.push(process.argv[index + 1]!);
  }
  return found;
}

function value(flag: string): string | undefined {
  return values(flag)[0];
}

function parseTarget(raw: string): Target {
  const separator = raw.indexOf('=');
  if (separator <= 0) return { name: 'target', url: raw };
  return { name: raw.slice(0, separator), url: raw.slice(separator + 1) };
}

function boundedNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`numero invalido: ${raw}`);
  return Math.round(Math.max(min, Math.min(max, value)));
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = units[0] ?? 'KB';
  for (let index = 1; value >= 1024 && index < units.length; index++) {
    value /= 1024;
    unit = units[index] ?? unit;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)}${unit}`;
}

void main().catch((error) => {
  console.error(`matriz falhou: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
