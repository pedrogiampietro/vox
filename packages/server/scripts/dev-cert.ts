/**
 * Gera um certificado de desenvolvimento para o WebTransport.
 *
 * O navegador aceita certificado autoassinado no WebTransport via
 * `serverCertificateHashes`, mas so dentro de regras estreitas: chave ECDSA
 * P-256, e validade de no maximo 14 dias. Fazer isso a mao com openssl e
 * receita de erro silencioso, entao o script cuida disso.
 *
 * Em producao nada disto e usado: la o certificado e valido e o navegador nao
 * precisa de dica nenhuma.
 *
 *   npm run dev-cert --workspace=@vox/server
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import { join, resolve } from 'node:path';
import * as x509 from '@peculiar/x509';

/** O teto do navegador e 14 dias; 13 deixa folga para o relogio do cliente. */
const VALID_DAYS = 13;

const OUT_DIR = resolve(process.argv[2] ?? 'data/dev-cert');

async function main(): Promise<void> {
  const crypto = webcrypto as unknown as Crypto;
  x509.cryptoProvider.set(crypto);

  const alg: EcKeyGenParams & { hash: string } = {
    name: 'ECDSA',
    namedCurve: 'P-256',
    hash: 'SHA-256',
  };
  const keys = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']);

  const notBefore = new Date(Date.now() - 60 * 60 * 1000); // 1h de folga
  const notAfter = new Date(Date.now() + VALID_DAYS * 24 * 60 * 60 * 1000);

  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: Date.now().toString(16),
    name: 'CN=localhost',
    notBefore,
    notAfter,
    signingAlgorithm: alg,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment,
        true,
      ),
      new x509.SubjectAlternativeNameExtension([
        { type: 'dns', value: 'localhost' },
        { type: 'ip', value: '127.0.0.1' },
        { type: 'ip', value: '::1' },
      ]),
    ],
  });

  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keys.privateKey);
  const certPem = cert.toString('pem');
  const keyPem = x509.PemConverter.encode([pkcs8], 'PRIVATE KEY');

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'cert.pem'), certPem);
  writeFileSync(join(OUT_DIR, 'key.pem'), keyPem);

  const hash = createHash('sha256').update(new Uint8Array(cert.rawData)).digest('hex');

  console.log(`certificado de desenvolvimento em ${OUT_DIR}`);
  console.log(`  validade  ate ${notAfter.toISOString()} (${VALID_DAYS} dias)`);
  console.log(`  sha-256   ${hash}`);
  console.log('\npara usar:');
  console.log(`  VOX_WT_CERT=${join(OUT_DIR, 'cert.pem')} \\`);
  console.log(`  VOX_WT_KEY=${join(OUT_DIR, 'key.pem')} \\`);
  console.log('  VOX_WT_PUBLISH_HASH=1 npm run dev:server');
}

main().catch((err) => {
  console.error('falha ao gerar o certificado:', err);
  process.exit(1);
});
