// Core of the daily run (PLAN.md §2), shared local/Worker: auth → fetch →
// diff → send → persistence. No node:* imports, no console output —
// the caller (digest.ts or the Durable Object) logs the returned summary.

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

  // Persisted AFTER a successful send: if Telegram fails, we'll re-report
  // the same items tomorrow (a duplicate beats a gap).
  await storage.putState(nextState);

  const durationS = ((Date.now() - startedAt) / 1000).toFixed(1);
  const summary = diff.isFirstRun
    ? `first run: baseline established (${diff.trackedCounts.bookmarks} bookmarks, ${diff.trackedCounts.likes} likes seen)`
    : `${diff.newBookmarks.length} new bookmark(s), ${diff.newLikes.length} new like(s)`;
  return `${summary} — ${durationS} s`;
}
