// Cœur du run quotidien (PLAN.md §2), partagé local/Worker : auth → fetch →
// diff → envoi → persistance. Aucun import node:*, aucune sortie console —
// l'appelant (digest.ts ou le Durable Object) logge le résumé retourné.

import { computeDiff } from './state.ts';
import type { Storage } from './storage.ts';
import { sendDigest, type TelegramDeps } from './telegram.ts';
import { getValidAccessToken } from './tokens.ts';
import type { Config } from './types.ts';
import { fetchBookmarksAndLikes } from './x.ts';

export async function runDigest(
  config: Config,
  storage: Storage,
  telegramDeps?: TelegramDeps,
): Promise<string> {
  const startedAt = Date.now();

  const { accessToken, userId } = await getValidAccessToken(config, storage);
  const fetched = await fetchBookmarksAndLikes(accessToken, userId, config);

  const previousState = await storage.getState();
  const { diff, nextState } = computeDiff(previousState, fetched, new Date().toISOString());

  await sendDigest(config, diff, telegramDeps);

  // Persisté APRÈS l'envoi réussi : si Telegram échoue, on re-signalera
  // les mêmes items demain (un doublon vaut mieux qu'un trou).
  await storage.putState(nextState);

  const durationS = ((Date.now() - startedAt) / 1000).toFixed(1);
  const summary = diff.isFirstRun
    ? `premier run : référence établie (${diff.trackedCounts.bookmarks} bookmarks, ${diff.trackedCounts.likes} likes vus)`
    : `${diff.newBookmarks.length} nouveau(x) bookmark(s), ${diff.newLikes.length} nouveau(x) like(s)`;
  return `${summary} — ${durationS} s`;
}
