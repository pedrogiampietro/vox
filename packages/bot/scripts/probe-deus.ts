/**
 * Smoke test dos scrapers HTML. Ideal para executar na VPS depois do deploy:
 *   npm run probe:deus -- Andromeda Memorium
 *
 * O script nao inicia nenhum bot nem publica mensagens no Vox.
 */

import { closeBrowserRuntime } from '../src/scrapers/browser.js';
import {
  closeDeusotBrowser,
  fetchDeaths as fetchDeusotDeaths,
  fetchWorldOnline,
  listWorlds as listDeusotWorlds,
} from '../src/scrapers/deusot.js';
import {
  closeDeusoldBrowser,
  fetchDeaths as fetchDeusoldDeaths,
  listWorlds as listDeusoldWorlds,
} from '../src/scrapers/deusold.js';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

async function main(): Promise<void> {
  const deusotWorld = arg(
    '--deusot-world',
    process.env['PROBE_DEUSOT_WORLD'] ?? process.argv[2] ?? 'Andromeda',
  );
  const deusoldWorld = arg(
    '--deusold-world',
    process.env['PROBE_DEUSOLD_WORLD'] ?? process.argv[3] ?? 'Memorium',
  );

  try {
    const [deusotWorlds, deusoldWorlds] = await Promise.all([
      listDeusotWorlds(),
      listDeusoldWorlds(),
    ]);
    const [deusotOnline, deusotDeaths, deusoldDeaths] = await Promise.all([
      fetchWorldOnline(deusotWorld),
      fetchDeusotDeaths(deusotWorld),
      fetchDeusoldDeaths(deusoldWorld),
    ]);

    console.log(JSON.stringify({
      ok: true,
      deusot: {
        world: deusotWorld,
        worlds: deusotWorlds,
        online: deusotOnline.length,
        deaths: deusotDeaths.length,
      },
      deusold: {
        world: deusoldWorld,
        worlds: deusoldWorlds,
        onlineRoster: false,
        deaths: deusoldDeaths.length,
      },
    }, null, 2));
  } finally {
    await closeDeusotBrowser();
    await closeDeusoldBrowser();
    await closeBrowserRuntime();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
