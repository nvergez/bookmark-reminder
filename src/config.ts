// Chargement de la config LOCALE (.env à la racine du projet). Le Worker
// construit son Config depuis ses bindings (worker/index.ts), sans ce module.

import path from 'node:path';
import { parseMaxResults } from './maxResults.ts';
import type { Config } from './types.ts';

export { parseMaxResults };

export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Charge .env (s'il existe) puis valide les variables requises.
 * scope 'auth' : seul X_CLIENT_ID est requis (npm run auth peut tourner
 * avant la création du bot Telegram).
 */
export function loadConfig(scope: 'auth' | 'digest' = 'digest'): Config {
  try {
    process.loadEnvFile(path.join(PROJECT_ROOT, '.env'));
  } catch {
    // pas de .env : les variables peuvent venir de l'environnement
  }

  const required =
    scope === 'auth'
      ? ['X_CLIENT_ID']
      : ['X_CLIENT_ID', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Variables manquantes dans .env : ${missing.join(', ')} — copier .env.example vers .env et le remplir (PLAN.md §3)`,
    );
  }

  return {
    xClientId: process.env.X_CLIENT_ID as string,
    xClientSecret: process.env.X_CLIENT_SECRET || null,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID ?? '',
    maxResults: parseMaxResults(process.env.MAX_RESULTS),
    tweetLinkDomain: process.env.TWEET_LINK_DOMAIN || 'x.com',
    reauthHint: 'relance `npm run auth` sur la machine du bot',
  };
}
