/**
 * Identidade do cliente: um par de chaves que vive neste navegador.
 *
 * O apelido nao prova nada - qualquer um digita qualquer coisa. O que o
 * servidor reconhece e a chave privada, que nunca sai daqui: ele manda um
 * desafio aleatorio, assinamos, e so entao a sessao recebe o grupo daquela
 * identidade.
 *
 * A chave e exportavel de proposito. Nao-exportavel seria mais seguro contra
 * script malicioso, mas impediria o usuario de levar a identidade para outra
 * maquina - e perder a identidade significa perder a posse do proprio
 * servidor. Trocar isso por seguranca teorica seria mau negocio.
 */

const STORAGE_KEY = 'vox.identity';
const KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' } as const;

export interface Identity {
  /** Chave publica em SPKI, enviada no Hello. */
  publicKey: Uint8Array;
  /** SHA-256 da chave publica, em hex. E o "quem" perante o servidor. */
  fingerprint: string;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

interface StoredIdentity {
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
}

let cached: Identity | null = null;

/** Carrega a identidade guardada ou cria uma na primeira execucao. */
export async function loadIdentity(): Promise<Identity> {
  if (cached) return cached;

  const stored = readStored();
  const pair = stored ? await importPair(stored) : await createPair();
  if (!stored) writeStored(pair.jwk);

  const publicKey = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const digest = await crypto.subtle.digest('SHA-256', publicKey);

  cached = {
    publicKey,
    fingerprint: hex(new Uint8Array(digest)),
    async sign(data) {
      return new Uint8Array(await crypto.subtle.sign(SIGN_ALGORITHM, pair.privateKey, new Uint8Array(data)));
    },
  };
  return cached;
}

/** Descarta a identidade atual e gera outra. O usuario vira outra pessoa. */
export async function resetIdentity(): Promise<Identity> {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // modo privado
  }
  cached = null;
  return loadIdentity();
}

/** Exporta para backup; e o que permite levar a identidade para outra maquina. */
export function exportIdentity(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Importa um backup. Retorna false se o conteudo nao for uma identidade. */
export async function importIdentity(raw: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(raw) as StoredIdentity;
    await importPair(parsed);
    localStorage.setItem(STORAGE_KEY, raw);
    cached = null;
    await loadIdentity();
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ interno --

async function createPair(): Promise<{
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  jwk: StoredIdentity;
}> {
  const pair = await crypto.subtle.generateKey(KEY_ALGORITHM, true, ['sign', 'verify']);
  return {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    jwk: {
      publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey),
      privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey),
    },
  };
}

async function importPair(stored: StoredIdentity): Promise<{
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  jwk: StoredIdentity;
}> {
  const publicKey = await crypto.subtle.importKey('jwk', stored.publicKey, KEY_ALGORITHM, true, [
    'verify',
  ]);
  const privateKey = await crypto.subtle.importKey('jwk', stored.privateKey, KEY_ALGORITHM, true, [
    'sign',
  ]);
  return { publicKey, privateKey, jwk: stored };
}

function readStored(): StoredIdentity | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredIdentity) : null;
  } catch {
    return null;
  }
}

function writeStored(jwk: StoredIdentity): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(jwk));
  } catch {
    // Modo privado: a identidade vale so por esta sessao, e tudo bem.
  }
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
