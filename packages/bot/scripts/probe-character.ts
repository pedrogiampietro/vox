/**
 * Diagnostico: testa varios endpoints candidatos pra achar a API real
 * do perfil de char no Rubinot. Roda com tsx (usa mesma stack do bot).
 *
 *   npx tsx packages/bot/scripts/probe-character.ts "Rangel Vendetta"
 */

import initCycleTLS from 'cycletls';

const name = process.argv[2] || 'Rangel Vendetta';
const encoded = encodeURIComponent(name);

const paths = [
  `/api/characters/${encoded}`,
  `/api/characters?name=${encoded}`,
  `/api/character/${encoded}`,
  `/api/character?name=${encoded}`,
  `/api/players/${encoded}`,
  `/api/player/${encoded}`,
  `/characters/api/${encoded}`,
  `/character.php?name=${encoded}`,
  // Next.js data endpoint (usado em SSG/ISR)
  `/_next/data/latest/characters.json?name=${encoded}`,
];

const JA3 =
  '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513-21,29-23-24,0';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function main(): Promise<void> {
  const c = await initCycleTLS();
  for (const p of paths) {
    const url = `https://rubinot.com.br${p}`;
    try {
      const r = await c.get(url, {
        ja3: JA3,
        userAgent: UA,
        headers: {
          accept: 'application/json,text/plain,*/*',
          'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8',
          referer: 'https://rubinot.com.br/',
        },
        timeout: 15,
      });
      const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      const preview = body.slice(0, 250).replace(/\s+/g, ' ');
      console.log(`${p} -> HTTP ${r.status}, ${body.length} bytes`);
      console.log(`  ${preview}`);
    } catch (err) {
      console.log(`${p} -> ERR ${(err as Error).message}`);
    }
  }
  await c.exit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
