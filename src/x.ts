// Minimal X API v2 client: bookmarks + likes, one page each (PLAN.md §6 —
// daily cadence, no pagination). No retry: the next daily run and the Telegram
// alert are enough (PLAN.md §2).

import type { Config, FetchResult, Tweet } from './types.ts';

const API_BASE = 'https://api.x.com/2';

// ---------------------------------------------------------------------------
// Home-made type guards (zero dependencies): we only validate what we consume.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface RawTweet {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
}

function isRawTweet(value: unknown): value is RawTweet {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || typeof value.text !== 'string') return false;
  if (value.author_id !== undefined && typeof value.author_id !== 'string') return false;
  if (value.created_at !== undefined && typeof value.created_at !== 'string') return false;
  return true;
}

interface RawUser {
  id: string;
  username: string;
  name: string;
}

function isRawUser(value: unknown): value is RawUser {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.username === 'string' &&
    typeof value.name === 'string'
  );
}

/**
 * The X v2 API returns `text` (and `name`) already HTML-escaped for & < >
 * (historical quirk: « R&D <3 » arrives as « R&amp;D &lt;3 »). We decode
 * here to store the RAW text in Tweet; telegram.ts re-escapes afterwards,
 * otherwise Telegram would display the entities literally (« R&amp;D »).
 * `&amp;` is decoded LAST: a tweet literally containing « &lt; »
 * arrives as « &amp;lt; » and must yield « &lt; » back, not « < ».
 */
export function decodeApiEntities(s: string): string {
  return s.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

/**
 * Transforms a raw v2 API payload (bookmarks or liked_tweets) into
 * Tweet[]. Pure and network-free, to be testable.
 *
 * - `data` missing = 0 results (normal API shape) → [].
 * - Author not found in includes.users → 'i'/'Unknown' and the
 *   universal URL https://{domain}/i/status/{id}.
 * - The order returned by the API is preserved (most recent first).
 */
export function mapTweets(payload: unknown, tweetLinkDomain: string): Tweet[] {
  if (!isRecord(payload)) {
    throw new Error(`Unexpected X response: not a JSON object (received: ${typeof payload})`);
  }

  const data = payload.data;
  if (data === undefined) return []; // 0 results: the API omits data
  if (!Array.isArray(data)) {
    throw new Error('Unexpected X response: the "data" field is not an array');
  }

  const usersById = new Map<string, RawUser>();
  const includes = payload.includes;
  if (includes !== undefined) {
    if (!isRecord(includes)) {
      throw new Error('Unexpected X response: the "includes" field is not an object');
    }
    const users = includes.users;
    if (users !== undefined) {
      if (!Array.isArray(users)) {
        throw new Error('Unexpected X response: "includes.users" is not an array');
      }
      for (const user of users) {
        if (!isRawUser(user)) {
          throw new Error('Unexpected X response: invalid entry in "includes.users"');
        }
        usersById.set(user.id, user);
      }
    }
  }

  return data.map((raw, index) => {
    if (!isRawTweet(raw)) {
      throw new Error(`Unexpected X response: invalid tweet at index ${index} of "data"`);
    }
    const author = raw.author_id !== undefined ? usersById.get(raw.author_id) : undefined;
    const authorUsername = author?.username ?? 'i';
    return {
      id: raw.id,
      text: decodeApiEntities(raw.text),
      authorUsername,
      authorName: author !== undefined ? decodeApiEntities(author.name) : 'Unknown',
      createdAt: raw.created_at ?? '',
      // /i/status/{id}: universal form when the author is unknown
      url: `https://${tweetLinkDomain}/${authorUsername}/status/${raw.id}`,
    };
  });
}

async function fetchTimeline(
  endpoint: 'bookmarks' | 'liked_tweets',
  accessToken: string,
  userId: string,
  config: Config,
): Promise<Tweet[]> {
  const url = new URL(`${API_BASE}/users/${userId}/${endpoint}`);
  url.searchParams.set('max_results', String(config.maxResults));
  url.searchParams.set('tweet.fields', 'created_at,author_id');
  url.searchParams.set('expansions', 'author_id');
  url.searchParams.set('user.fields', 'username,name');

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const body = (await response.text().catch(() => '')).slice(0, 300);
    let hint = '';
    if (response.status === 401) {
      hint = ` — invalid or expired token, ${config.reauthHint}`;
    } else if (response.status === 429) {
      hint = ' — X rate limit reached, retry later';
    }
    throw new Error(
      `X call failed GET /2/users/:id/${endpoint} (HTTP ${response.status})${hint}. Body: ${body}`,
    );
  }

  const payload: unknown = await response.json();
  return mapTweets(payload, config.tweetLinkDomain);
}

/** Fetches one page of bookmarks and one page of likes (in parallel). */
export async function fetchBookmarksAndLikes(
  accessToken: string,
  userId: string,
  config: Config,
): Promise<FetchResult> {
  const [bookmarks, likes] = await Promise.all([
    fetchTimeline('bookmarks', accessToken, userId, config),
    fetchTimeline('liked_tweets', accessToken, userId, config),
  ]);
  return { bookmarks, likes };
}
