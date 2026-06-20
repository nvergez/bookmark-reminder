// ID diff and state validation — pure logic, no node:* imports:
// persistence lives behind the Storage abstraction (fsStorage.ts / Worker).

import type { BotState, DigestDiff, FetchResult, Tweet } from './types.ts';

/** Cap on IDs retained per list (PLAN.md E3). */
export const STATE_MAX_IDS = 2000;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Validates the shape of a persisted state (local file or Durable Object).
 * Invalid shape → throw: the digest must ALERT, not silently start from
 * scratch (a lost state = re-digesting all the recent history).
 * `source` adds context to the message (file path, "Durable Object"...).
 */
export function validateStateShape(parsed: unknown, source: string): BotState {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`invalid state (object expected): ${source}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (!isStringArray(obj.bookmarkIds) || !isStringArray(obj.likeIds)) {
    throw new Error(
      `invalid state (bookmarkIds/likeIds must be arrays of strings): ${source}`,
    );
  }
  if (obj.lastRunAt !== null && typeof obj.lastRunAt !== 'string') {
    throw new Error(`invalid state (lastRunAt must be a string or null): ${source}`);
  }

  return {
    bookmarkIds: obj.bookmarkIds,
    likeIds: obj.likeIds,
    lastRunAt: obj.lastRunAt,
  };
}

/**
 * Diff of one list: new tweets (API order preserved, most recent first) +
 * the next list of IDs. We keep the old IDs that weren't seen again because
 * a tweet can drop out of the max_results window while still being bookmarked:
 * seeing it again later must NOT re-flag it.
 */
function diffList(
  previousIds: string[],
  fetched: Tweet[],
): { newTweets: Tweet[]; nextIds: string[] } {
  const previousSet = new Set(previousIds);
  const newTweets = fetched.filter((tweet) => !previousSet.has(tweet.id));

  const nextIds: string[] = [];
  const seen = new Set<string>();
  for (const tweet of fetched) {
    if (!seen.has(tweet.id)) {
      seen.add(tweet.id);
      nextIds.push(tweet.id);
    }
  }
  for (const id of previousIds) {
    if (!seen.has(id)) {
      seen.add(id);
      nextIds.push(id);
    }
  }

  return { newTweets, nextIds: nextIds.slice(0, STATE_MAX_IDS) };
}

/**
 * PURE. previous === null → first run: we establish the baseline without
 * flagging any new items (PLAN.md §6). Bookmarks and likes are diffed
 * independently.
 */
export function computeDiff(
  previous: BotState | null,
  fetched: FetchResult,
  nowIso: string,
): { diff: DigestDiff; nextState: BotState } {
  const trackedCounts = { bookmarks: fetched.bookmarks.length, likes: fetched.likes.length };

  if (previous === null) {
    return {
      diff: { newBookmarks: [], newLikes: [], isFirstRun: true, trackedCounts },
      nextState: {
        bookmarkIds: diffList([], fetched.bookmarks).nextIds,
        likeIds: diffList([], fetched.likes).nextIds,
        lastRunAt: nowIso,
      },
    };
  }

  const bookmarks = diffList(previous.bookmarkIds, fetched.bookmarks);
  const likes = diffList(previous.likeIds, fetched.likes);

  return {
    diff: {
      newBookmarks: bookmarks.newTweets,
      newLikes: likes.newTweets,
      isFirstRun: false,
      trackedCounts,
    },
    nextState: {
      bookmarkIds: bookmarks.nextIds,
      likeIds: likes.nextIds,
      lastRunAt: nowIso,
    },
  };
}
