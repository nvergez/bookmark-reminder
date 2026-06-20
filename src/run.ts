// Core of the daily run (PLAN.md §2), shared local/Worker: auth → fetch →
// diff → AI enrichment → send → persistence. No node:* imports, no console
// output — the caller (digest.ts or the Durable Object) logs the returned
// summary, which also carries the AI status.

import { enrichDigest, type AiDeps, type AiOutcome } from './ai.ts';
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
  aiDeps?: AiDeps,
): Promise<string> {
  const startedAt = Date.now();

  const { accessToken, userId } = await getValidAccessToken(config, storage);
  const fetched = await fetchBookmarksAndLikes(accessToken, userId, config);

  const previousState = await storage.getState();
  const { diff, nextState } = computeDiff(previousState, fetched, new Date().toISOString());

  // Fail-open AI enrichment (PLAN-IA-DIGEST.md §3): enrichDigest handles
  // "skipped" internally and captures its own errors — this try/catch is the
  // last net against an unforeseen exception. A Claude failure never removes
  // the digest nor blocks putState.
  let aiOutcome: AiOutcome;
  try {
    aiOutcome = await enrichDigest(config, diff, aiDeps);
  } catch (err) {
    aiOutcome = { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }

  await sendDigest(config, diff, aiOutcome, telegramDeps);

  // Persisted AFTER a successful send: if Telegram fails, we'll re-report
  // the same items tomorrow (a duplicate beats a gap).
  await storage.putState(nextState);

  const durationS = ((Date.now() - startedAt) / 1000).toFixed(1);
  const summary = diff.isFirstRun
    ? `first run: baseline established (${diff.trackedCounts.bookmarks} bookmarks, ${diff.trackedCounts.likes} likes seen)`
    : `${diff.newBookmarks.length} new bookmark(s), ${diff.newLikes.length} new like(s)`;
  // AI status suffix: the local console and `wrangler tail` carry the cause
  // of a failure without console.* here. Nothing when "skipped": the current
  // strings stay byte-identical.
  const aiStatus =
    aiOutcome.status === 'ok'
      ? ' — AI summary: ok'
      : aiOutcome.status === 'failed'
        ? ` — AI summary: failed (${aiOutcome.reason})`
        : '';
  return `${summary} — ${durationS} s${aiStatus}`;
}
