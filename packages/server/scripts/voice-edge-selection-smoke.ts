import { strict as assert } from 'node:assert';
import type { VoiceEdge } from '@vox/protocol';
import { orderVoiceEdges } from '../src/voice-edge-selection.js';

const origin: VoiceEdge = {
  host: 'server-1.v0x.online',
  port: 9987,
  region: 'Origem',
  certHash: new Uint8Array(),
};
const saoPaulo: VoiceEdge = {
  host: 'voice-sp.v0x.online',
  port: 9987,
  region: 'São Paulo',
  certHash: new Uint8Array(),
};
const europa: VoiceEdge = {
  host: 'voice-eu.v0x.online',
  port: 9987,
  region: 'Europa',
  certHash: new Uint8Array(),
};

const now = 1_000_000;
const healthy = [
  { id: 'voice-sp', connected: true, available: true, lastSeenAt: now, sessions: 20, p95Ms: 80 },
  { id: 'voice-eu', connected: true, available: true, lastSeenAt: now, sessions: 5, p95Ms: 120 },
];

const first = orderVoiceEdges([origin, saoPaulo, europa], {
  serverId: 5,
  origin,
  health: healthy,
  now,
});
assert.equal(first.length, 3);
assert.equal(first[0]?.host, 'voice-sp.v0x.online');
assert.equal(first.at(-1)?.host, 'server-1.v0x.online');

const second = orderVoiceEdges([origin, saoPaulo, europa], {
  serverId: 5,
  origin,
  health: healthy,
  now,
});
assert.deepEqual(second.map((edge) => edge.host), first.map((edge) => edge.host));

const fallback = orderVoiceEdges([origin, saoPaulo, europa], {
  serverId: 5,
  origin,
  health: healthy.map((item) => ({ ...item, connected: false, available: false, lastSeenAt: now - 60_000 })),
  now,
});
assert.equal(fallback[0]?.host, 'server-1.v0x.online');

console.log('voice-edge-selection smoke: ok');
