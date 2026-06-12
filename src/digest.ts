// Adaptateur LOCAL du run quotidien : config .env + FsStorage + sortie
// console/exit codes pour launchd. Le cœur du run est dans run.ts (partagé
// avec le Worker Cloudflare). Exécuté par `npm run digest`.

import { loadConfig, PROJECT_ROOT } from './config.ts';
import { FsStorage } from './fsStorage.ts';
import { runDigest } from './run.ts';
import { sendErrorAlert } from './telegram.ts';
import type { Config } from './types.ts';

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig('digest');
  } catch (err) {
    // Pas de config → pas de Telegram possible : seul le log launchd témoigne.
    // Message seul (pas de stack) : l'erreur est actionnable telle quelle.
    console.error(
      `Échec du chargement de la configuration : ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  try {
    const summary = await runDigest(config, new FsStorage(PROJECT_ROOT));
    console.log(`Digest OK — ${summary}`);
  } catch (err) {
    console.error('Échec du run digest :', err instanceof Error ? (err.stack ?? err.message) : err);
    // Best-effort, ne throw jamais : la panne reste visible côté Telegram (PLAN.md §1).
    await sendErrorAlert(config, err);
    process.exit(1);
  }
}

await main();
