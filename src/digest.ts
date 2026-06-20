// LOCAL adapter for the daily run: .env config + FsStorage + console output /
// exit codes for launchd. The core of the run lives in run.ts (shared with the
// Cloudflare Worker). Run by `npm run digest`.

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
    // No config → Telegram isn't possible: only the launchd log bears witness.
    // Message only (no stack): the error is actionable as is.
    console.error(
      `Failed to load configuration: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  try {
    const summary = await runDigest(config, new FsStorage(PROJECT_ROOT));
    console.log(`Digest OK — ${summary}`);
  } catch (err) {
    console.error('Digest run failed:', err instanceof Error ? (err.stack ?? err.message) : err);
    // Best-effort, never throws: the failure stays visible on the Telegram side (PLAN.md §1).
    await sendErrorAlert(config, err);
    process.exit(1);
  }
}

await main();
