/**
 * Teste de capacidade comercial: quantos servidores virtuais cabem em um
 * processo e em uma VPS.
 *
 * Com --provision, cria servidores temporarios via painel, executa cenarios
 * concorrentes e remove apenas os IDs que criou. O teste usa o protocolo real
 * e voz sintetica; Rubinot e fontes reais do Jukebox sao outra dimensao.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

type Scenario = {
  name: string;
  serverCount: number;
  clientsPerServer: number;
  speakersPerServer: number;
};

type Target = { name: string; url: string };

type StressSummary = {
  target: string;
  clientsRequested: number;
  clientsActive: number;
  socketsOpen: number;
  voiceSent: number;
  voiceReceived: number;
  rttMs: { p50: number; p95: number; p99: number; samples: number };
  failures: string[];
  adminRuntime: {
    processCpuPercent: number;
    hostCpuPercent: number;
    eventLoopLagMs: number;
    eventLoopLagP95Ms: number;
    memory: { rssBytes: number; systemUsedPercent: number };
    traffic: { inboundKbps: number; outboundKbps: number };
  } | null;
  pass: boolean;
};

type ScenarioResult = Scenario & { target: string; summary: StressSummary | null; exitCode: number };
type CreatedServer = { id: number; target: Target };

const SCENARIOS: Scenario[] = [
  { name: '1x150-conexoes', serverCount: 1, clientsPerServer: 150, speakersPerServer: 0 },
  { name: '1x150-voz', serverCount: 1, clientsPerServer: 150, speakersPerServer: 6 },
  { name: '1x200-conexoes', serverCount: 1, clientsPerServer: 200, speakersPerServer: 0 },
  { name: '1x200-voz', serverCount: 1, clientsPerServer: 200, speakersPerServer: 8 },
  { name: '1x300-conexoes', serverCount: 1, clientsPerServer: 300, speakersPerServer: 0 },
  { name: '1x300-voz', serverCount: 1, clientsPerServer: 300, speakersPerServer: 12 },
  { name: '1x300-voz-leve', serverCount: 1, clientsPerServer: 300, speakersPerServer: 4 },
  { name: '10x50-conexoes', serverCount: 10, clientsPerServer: 50, speakersPerServer: 0 },
  { name: '10x50-voz-leve', serverCount: 10, clientsPerServer: 50, speakersPerServer: 1 },
  { name: '10x50-voz-medio', serverCount: 10, clientsPerServer: 50, speakersPerServer: 2 },
  { name: '10x50-voz', serverCount: 10, clientsPerServer: 50, speakersPerServer: 3 },
];

const options = parseOptions();

async function main(): Promise<void> {
  for (const target of options.targets) ensureSafeTarget(target.url);
  const reportDir = resolve(options.outputDir);
  mkdirSync(reportDir, { recursive: true });
  const created: CreatedServer[] = [];
  const adminTokens = new Map<string, string>();
  const results: ScenarioResult[] = [];
  try {
    const servers = options.provision ? await provisionServers(created, adminTokens) : missingProvision();
    for (const target of options.targets) {
      for (const scenario of options.scenarios) {
        const ids = servers.get(`${target.name}:${scenario.name}`) ?? [];
        console.log(`\n=== ${target.name} / ${scenario.name} ===`);
        results.push(await runScenario(target, scenario, ids, adminTokens.get(target.name) ?? '', join(reportDir, `${safeName(target.name)}-${safeName(scenario.name)}`)));
      }
    }
  } finally {
    await removeCreatedServers(created, adminTokens);
  }
  const report = {
    generatedAt: new Date().toISOString(),
    durationSec: options.durationSec,
    voice: { bytes: Number(process.env.STRESS_VOICE_BYTES ?? 96), intervalMs: Number(process.env.STRESS_VOICE_INTERVAL_MS ?? 20) },
    note: `Capacidade de protocolo/voz sintetica; Rubinot ausente; Jukebox ${process.env.VOX_JUKEBOX_ENABLED === '0' ? 'desligado' : 'ligado'}.`,
    results,
  };
  const reportFile = join(reportDir, 'report.json');
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  printReport(results, reportFile);
  if (results.some((result) => result.exitCode !== 0 || result.summary?.pass === false)) process.exitCode = 1;
}

async function provisionServers(created: CreatedServer[], adminTokens: Map<string, string>): Promise<Map<string, number[]>> {
  const result = new Map<string, number[]>();
  for (const target of options.targets) {
    const token = await adminToken(target);
    adminTokens.set(target.name, token);
    for (const scenario of options.scenarios) {
      const ids: number[] = [];
      for (let index = 0; index < scenario.serverCount; index++) {
        const suffix = `${safeName(target.name)}-${safeName(scenario.name)}-${index + 1}`;
        const body = await adminRequest(target, token, 'POST', '/api/servers', {
          name: `Stress ${scenario.name} ${index + 1}`,
          slug: `stress-${suffix}`,
          maxClients: scenario.clientsPerServer,
        });
        const id = Number(body.id);
        if (!Number.isInteger(id) || id <= 0) throw new Error(`servidor temporario sem id em ${target.name}/${scenario.name}`);
        ids.push(id);
        created.push({ id, target });
      }
      result.set(`${target.name}:${scenario.name}`, ids);
      console.log(`provisionado ${target.name}/${scenario.name}: ${ids.length} servidor(es)`);
    }
  }
  return result;
}

async function runScenario(target: Target, scenario: Scenario, ids: number[], adminTokenValue: string, filePrefix: string): Promise<ScenarioResult> {
  if (ids.length !== scenario.serverCount) return { ...scenario, target: target.name, summary: null, exitCode: 1 };
  const parts = await Promise.all(ids.map((id, index) => runServerStress(
    target,
    scenario,
    id,
    index === 0 ? adminTokenValue : '',
    `${filePrefix}-${index + 1}.json`,
  )));
  const summaries = parts.map((part) => part.summary).filter((summary): summary is StressSummary => summary !== null);
  const combined = combineSummaries(target.url, summaries);
  const summary = combined
    ? { ...combined, failures: summaries.flatMap((part) => part.failures), pass: parts.every((part) => part.exitCode === 0 && part.summary?.pass === true) }
    : null;
  if (summary) console.log(`capacidade: ${summary.clientsActive}/${summary.clientsRequested} ativos · RTT p95 ${formatMs(summary.rttMs.p95)} · ${summary.pass ? 'PASS' : 'FAIL'}`);
  return { ...scenario, target: target.name, summary, exitCode: parts.some((part) => part.exitCode !== 0) ? 1 : 0 };
}

function runServerStress(target: Target, scenario: Scenario, serverId: number, token: string, outputFile: string): Promise<{ summary: StressSummary | null; exitCode: number }> {
  const child = spawn(process.execPath, [
    resolve('node_modules/tsx/dist/cli.mjs'),
    'packages/server/scripts/stress.ts',
    '--url', serverUrl(target.url, serverId),
    '--clients', String(scenario.clientsPerServer),
    '--speakers', String(scenario.speakersPerServer),
    '--duration', String(options.durationSec),
  ], {
    cwd: process.cwd(),
    env: { ...process.env, STRESS_ADMIN_TOKEN: token, STRESS_JSON_OUT: outputFile },
    stdio: 'inherit',
    windowsHide: true,
  });
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      let summary: StressSummary | null = null;
      try { summary = JSON.parse(readFileSync(outputFile, 'utf8')) as StressSummary; } catch { /* o terminal ja mostra o resumo */ }
      resolvePromise({ summary, exitCode: code ?? (signal ? 1 : 0) });
    });
  });
}

function combineSummaries(target: string, summaries: StressSummary[]): StressSummary | null {
  const first = summaries[0];
  if (!first) return null;
  return {
    target,
    clientsRequested: summaries.reduce((sum, item) => sum + item.clientsRequested, 0),
    clientsActive: summaries.reduce((sum, item) => sum + item.clientsActive, 0),
    socketsOpen: summaries.reduce((sum, item) => sum + item.socketsOpen, 0),
    voiceSent: summaries.reduce((sum, item) => sum + item.voiceSent, 0),
    voiceReceived: summaries.reduce((sum, item) => sum + item.voiceReceived, 0),
    rttMs: {
      p50: Math.max(...summaries.map((item) => item.rttMs.p50)),
      p95: Math.max(...summaries.map((item) => item.rttMs.p95)),
      p99: Math.max(...summaries.map((item) => item.rttMs.p99)),
      samples: summaries.reduce((sum, item) => sum + item.rttMs.samples, 0),
    },
    failures: summaries.flatMap((item) => item.failures),
    adminRuntime: summaries.find((item) => item.adminRuntime)?.adminRuntime ?? null,
    pass: summaries.every((item) => item.pass),
  };
}

async function adminToken(target: Target): Promise<string> {
  if (process.env.STRESS_ADMIN_TOKEN) return process.env.STRESS_ADMIN_TOKEN;
  const password = process.env.STRESS_ADMIN_PASSWORD;
  if (!password) throw new Error('defina STRESS_ADMIN_TOKEN ou STRESS_ADMIN_PASSWORD para provisionar');
  const body = await adminRequest(target, '', 'POST', '/api/login', { password });
  if (typeof body.token !== 'string' || body.token.length === 0) throw new Error(`login administrativo sem token em ${target.name}`);
  return body.token;
}

async function adminRequest(target: Target, token: string, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(httpUrl(target.url, path), {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${String(result.error ?? '')}`.trim());
  return result;
}

async function removeCreatedServers(created: CreatedServer[], adminTokens: Map<string, string>): Promise<void> {
  if (created.length === 0) return;
  for (const item of [...created].reverse()) {
    const token = adminTokens.get(item.target.name) ?? process.env.STRESS_ADMIN_TOKEN ?? '';
    if (!token) { console.log(`limpeza ignorada no alvo ${item.target.name}: token administrativo ausente`); continue; }
    try { await adminRequest(item.target, token, 'DELETE', `/api/servers/${item.id}`); }
    catch (error) { console.error(`nao foi possivel remover servidor temporario ${item.id}: ${error instanceof Error ? error.message : String(error)}`); }
  }
}

function printReport(results: ScenarioResult[], reportFile: string): void {
  console.log('\n=== resumo de capacidade ===');
  console.log('alvo | caso | servidores | clientes | ativos | RTT p95 | CPU processo | RSS | saida | resultado');
  for (const result of results) {
    const summary = result.summary;
    if (!summary) { console.log(`${result.target} | ${result.name} | ${result.serverCount} | sem resumo | FAIL`); continue; }
    const runtime = summary.adminRuntime;
    console.log([
      result.target, result.name, result.serverCount, summary.clientsRequested,
      `${summary.clientsActive}/${summary.clientsRequested}`, `${summary.rttMs.p95.toFixed(0)}ms`,
      runtime ? `${runtime.processCpuPercent.toFixed(1)}%` : 'n/d',
      runtime ? formatBytes(runtime.memory.rssBytes) : 'n/d',
      runtime ? `${runtime.traffic.outboundKbps.toFixed(1)}kbps` : 'n/d',
      summary.pass && result.exitCode === 0 ? 'PASS' : 'FAIL',
    ].join(' | '));
  }
  console.log(`\nrelatorio: ${reportFile}`);
}

function parseOptions(): { targets: Target[]; scenarios: Scenario[]; provision: boolean; durationSec: number; outputDir: string } {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Uso: npm run stress:capacity -- --target nome=WS_URL --provision [--only CENARIO] [--duration SEC] [--output DIR]');
    console.log(`Cenarios: ${SCENARIOS.map((scenario) => scenario.name).join(', ')}`);
    process.exit(0);
  }
  const targets = values('--target').map(parseTarget);
  if (targets.length === 0) throw new Error('informe pelo menos um --target nome=WS_URL');
  const selected = values('--only');
  const scenarios = selected.length > 0
    ? SCENARIOS.filter((scenario) => selected.includes(scenario.name))
    : SCENARIOS;
  if (scenarios.length === 0) throw new Error(`nenhum cenario encontrado em --only; disponiveis: ${SCENARIOS.map((scenario) => scenario.name).join(', ')}`);
  return {
    targets,
    scenarios,
    provision: process.argv.includes('--provision'),
    durationSec: boundedNumber(value('--duration'), 30, 1, 3600),
    outputDir: value('--output') ?? '.tmp-stress-capacity',
  };
}

function values(flag: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < process.argv.length; index++) if (process.argv[index] === flag && process.argv[index + 1]) found.push(process.argv[index + 1]!);
  return found;
}

function value(flag: string): string | undefined { return values(flag)[0]; }
function parseTarget(raw: string): Target { const separator = raw.indexOf('='); return separator <= 0 ? { name: 'target', url: raw } : { name: raw.slice(0, separator), url: raw.slice(separator + 1) }; }

function ensureSafeTarget(wsUrl: string): void {
  const hostname = new URL(wsUrl).hostname;
  const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (!local && process.env.STRESS_CONFIRM !== '1') throw new Error('capacidade remota bloqueada; defina STRESS_CONFIRM=1 e confirme a janela antes de provisionar');
}

function serverUrl(base: string, id: number): string { const url = new URL(base); url.pathname = `${url.pathname.replace(/\/$/, '')}/${id}`; return url.toString(); }
function httpUrl(wsUrl: string, path: string): string { const url = new URL(wsUrl); url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'; url.pathname = path; url.search = ''; return url.toString(); }
function missingProvision(): never { throw new Error('este teste precisa de --provision para criar a matriz de servidores temporarios'); }
function boundedNumber(raw: string | undefined, fallback: number, min: number, max: number): number { const value = raw === undefined ? fallback : Number(raw); if (!Number.isFinite(value)) throw new Error(`numero invalido: ${raw}`); return Math.round(Math.max(min, Math.min(max, value))); }
function safeName(value: string): string { return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'item'; }
function formatMs(value: number): string { return `${value.toFixed(value >= 10 ? 0 : 1)}ms`; }
function formatBytes(bytes: number): string { if (bytes < 1024) return `${Math.round(bytes)}B`; const units = ['KB', 'MB', 'GB', 'TB']; let value = bytes / 1024; let unit = units[0] ?? 'KB'; for (let index = 1; value >= 1024 && index < units.length; index++) { value /= 1024; unit = units[index] ?? unit; } return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)}${unit}`; }

void main().catch((error) => {
  console.error(`capacidade falhou: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
