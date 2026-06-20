// Loading the LOCAL config (.env at the project root). The Worker
// builds its Config from its bindings (worker/index.ts), without this module.

import path from 'node:path';
import { parseMaxResults } from './maxResults.ts';
import type { Config } from './types.ts';

export { parseMaxResults };

export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Loads .env (if it exists) then validates the required variables.
 * scope 'auth': only X_CLIENT_ID is required (npm run auth can run
 * before the Telegram bot is created).
 */
export function loadConfig(scope: 'auth' | 'digest' = 'digest'): Config {
  try {
    process.loadEnvFile(path.join(PROJECT_ROOT, '.env'));
  } catch {
    // no .env: variables may come from the environment
  }

  const required =
    scope === 'auth'
      ? ['X_CLIENT_ID']
      : ['X_CLIENT_ID', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing variables in .env: ${missing.join(', ')} — copy .env.example to .env and fill it in (PLAN.md §3)`,
    );
  }

  return {
    xClientId: process.env.X_CLIENT_ID as string,
    xClientSecret: process.env.X_CLIENT_SECRET || null,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID ?? '',
    maxResults: parseMaxResults(process.env.MAX_RESULTS),
    tweetLinkDomain: process.env.TWEET_LINK_DOMAIN || 'x.com',
    reauthHint: 're-run `npm run auth` on the bot machine',
  };
}
