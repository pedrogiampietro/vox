/**
 * Identidade por par de chaves, no espirito do TS3.
 *
 * O apelido nao identifica ninguem - qualquer um digita qualquer coisa. O que
 * identifica e a chave privada que o cliente guarda e nunca envia. No
 * handshake o servidor manda um desafio aleatorio, o cliente assina, e so
 * entao a sessao ganha o grupo daquela identidade.
 *
 * Sem essa prova, grupo e banimento seriam decoracao: bastaria dizer "sou o
 * dono" para virar dono.
 */

import { webcrypto } from 'node:crypto';

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGNATURE = { name: 'ECDSA', hash: 'SHA-256' } as const;

/** P-256 SPKI tem 91 bytes; a folga cobre codificacoes ligeiramente diferentes. */
const MAX_PUBLIC_KEY_BYTES = 256;
/** Assinatura ECDSA P-256 crua: r||s, 64 bytes. */
const MAX_SIGNATURE_BYTES = 144;

/**
 * Impressao digital: SHA-256 da chave publica, em hex.
 *
 * E ela que aparece na lista de banidos e na tabela de grupos - guardar a
 * chave inteira nao acrescenta nada e ocupa dez vezes mais espaco.
 */
export async function fingerprintOf(publicKey: Uint8Array): Promise<string> {
  const digest = await webcrypto.subtle.digest('SHA-256', publicKey);
  return Buffer.from(digest).toString('hex');
}

/** Verifica a assinatura do desafio. Qualquer erro vira `false`, nunca excecao. */
export async function verifyChallenge(
  publicKey: Uint8Array,
  signature: Uint8Array,
  nonce: Uint8Array,
): Promise<boolean> {
  if (publicKey.length === 0 || publicKey.length > MAX_PUBLIC_KEY_BYTES) return false;
  if (signature.length === 0 || signature.length > MAX_SIGNATURE_BYTES) return false;

  try {
    const key = await webcrypto.subtle.importKey('spki', publicKey, ALGORITHM, false, ['verify']);
    return await webcrypto.subtle.verify(SIGNATURE, key, signature, nonce);
  } catch {
    // Chave malformada e indistinguivel de assinatura errada, do nosso ponto
    // de vista: nos dois casos a sessao nao provou nada.
    return false;
  }
}

/** Rejeita cedo o que nem chega a parecer uma chave, antes de gastar CPU. */
export function looksLikePublicKey(publicKey: Uint8Array): boolean {
  return publicKey.length > 0 && publicKey.length <= MAX_PUBLIC_KEY_BYTES;
}
