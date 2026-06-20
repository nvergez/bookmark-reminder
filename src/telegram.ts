// Telegram sender (PLAN.md E4): notifying recap + silent items with
// rich preview, "nothing new" and silent first run, error alert.

import type { Config, DigestDiff, Tweet } from './types.ts';

/** Injectable dependencies for tests (no network, no real timer). */
export interface TelegramDeps {
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
}

const TELEGRAM_API_BASE = 'https://api.telegram.org';
/** ~1 msg/s allowed by Telegram → 1.1 s margin between two sends */
const THROTTLE_MS = 1100;
const MESSAGE_MAX = 4096;
const TWEET_EXCERPT_MAX = 280;
const ERROR_EXCERPT_MAX = 1000;

interface LinkPreviewOptions {
  is_disabled?: boolean;
  url?: string;
  prefer_large_media?: boolean;
}

interface OutgoingMessage {
  text: string;
  silent: boolean;
  linkPreview: LinkPreviewOptions;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Telegram's HTML API only requires these three characters. */
export function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Splits a message into chunks ≤ max, preferably on a newline,
 * without cutting an HTML entity (&amp; …) or a Unicode surrogate pair.
 * Never produces an empty chunk.
 */
export function chunkMessage(s: string, max = MESSAGE_MAX): string[] {
  if (s.length === 0) return [];
  if (s.length <= max) return [s];

  const chunks: string[] = [];
  let rest = s;
  while (rest.length > max) {
    const newline = rest.lastIndexOf('\n', max);
    let cut: number;
    let skip: number;
    if (newline >= 0) {
      cut = newline;
      skip = 1; // the split \n is not carried over into any chunk
    } else {
      cut = hardCut(rest, max);
      skip = 0;
    }
    const chunk = rest.slice(0, cut);
    if (chunk.trim().length > 0) chunks.push(chunk); // never an empty/blank chunk
    rest = rest.slice(cut + skip);
  }
  if (rest.trim().length > 0) chunks.push(rest);
  return chunks;
}

/** Hard cut at max, moved back if it would fall in the middle of a simple
 * HTML entity or a surrogate pair. */
function hardCut(s: string, max: number): number {
  let cut = max;
  const amp = s.lastIndexOf('&', cut - 1);
  if (amp > 0 && cut - amp < 10) {
    const semi = s.indexOf(';', amp);
    if (semi >= cut) cut = amp; // the entity overlaps the cut → cut before the &
  }
  const code = s.charCodeAt(cut - 1);
  if (cut > 1 && code >= 0xd800 && code <= 0xdbff) cut -= 1;
  if (cut <= 0) cut = max; // guarantee progress
  return cut;
}

/** Truncates on a clean boundary (space) and adds an ellipsis. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.lastIndexOf(' ', max);
  if (cut < max / 2) cut = max; // no reasonable space: hard cut
  const code = s.charCodeAt(cut - 1);
  if (cut > 1 && code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return s.slice(0, cut).trimEnd() + '…';
}

async function postSendMessage(
  config: Config,
  text: string,
  message: OutgoingMessage,
  fetchFn: typeof fetch,
): Promise<Response> {
  const url = `${TELEGRAM_API_BASE}/bot${config.telegramBotToken}/sendMessage`;
  return fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text,
      parse_mode: 'HTML',
      disable_notification: message.silent,
      link_preview_options: message.linkPreview,
    }),
  });
}

async function readRetryAfterSeconds(res: Response): Promise<number> {
  try {
    const body = (await res.json()) as { parameters?: { retry_after?: number } };
    const retryAfter = body.parameters?.retry_after;
    return typeof retryAfter === 'number' && retryAfter > 0 ? retryAfter : 5;
  } catch {
    return 5;
  }
}

async function ensureOk(res: Response): Promise<void> {
  let bodyText = '';
  try {
    bodyText = await res.text();
  } catch {
    // unreadable body: the error will at least carry the HTTP status
  }
  if (!res.ok) {
    throw new Error(`Telegram sendMessage: HTTP ${res.status} — ${bodyText.slice(0, 300)}`);
  }
  let parsed: { ok?: boolean; description?: string } = {};
  try {
    parsed = JSON.parse(bodyText) as { ok?: boolean; description?: string };
  } catch {
    return; // 2xx non-JSON: we consider the send successful
  }
  if (parsed.ok !== true) {
    throw new Error(`Telegram sendMessage: ok=false — ${parsed.description ?? bodyText.slice(0, 300)}`);
  }
}

/** Low-level send of a chunk, with a single retry on HTTP 429. */
async function sendChunk(
  config: Config,
  text: string,
  message: OutgoingMessage,
  fetchFn: typeof fetch,
  sleepFn: (ms: number) => Promise<void>,
): Promise<void> {
  let res = await postSendMessage(config, text, message, fetchFn);
  if (res.status === 429) {
    const retryAfter = await readRetryAfterSeconds(res);
    await sleepFn(retryAfter * 1000);
    res = await postSendMessage(config, text, message, fetchFn);
  }
  await ensureOk(res);
}

async function sendAll(config: Config, messages: OutgoingMessage[], deps: TelegramDeps): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleepFn = deps.sleepFn ?? defaultSleep;
  let first = true;
  for (const message of messages) {
    for (const chunk of chunkMessage(message.text)) {
      if (!first) await sleepFn(THROTTLE_MS);
      first = false;
      await sendChunk(config, chunk, message, fetchFn, sleepFn);
    }
  }
}

function pluralS(n: number): string {
  return n > 1 ? 's' : '';
}

function tweetMessage(prefix: string, tweet: Tweet): OutgoingMessage {
  const header = `${prefix} <b>${escapeHtml(tweet.authorName)} @${escapeHtml(tweet.authorUsername)}</b>`;
  const excerpt = escapeHtml(truncate(tweet.text, TWEET_EXCERPT_MAX));
  return {
    // plain URL on its own line: it's what carries the rich preview
    text: `${header}\n${excerpt}\n\n${tweet.url}`,
    silent: true,
    linkPreview: { url: tweet.url, prefer_large_media: true },
  };
}

function buildDigestMessages(diff: DigestDiff): OutgoingMessage[] {
  const noPreview: LinkPreviewOptions = { is_disabled: true };

  if (diff.isFirstRun) {
    // newBookmarks/newLikes are always empty on the first run (computeDiff):
    // the real recorded totals are in trackedCounts.
    const b = diff.trackedCounts.bookmarks;
    const l = diff.trackedCounts.likes;
    return [
      {
        text:
          `🌱 Baseline established: ${b} bookmark${pluralS(b)} and ${l} like${pluralS(l)} tracked. ` +
          'New items will arrive starting tomorrow ☀️',
        silent: true,
        linkPreview: noPreview,
      },
    ];
  }

  const b = diff.newBookmarks.length;
  const l = diff.newLikes.length;
  if (b === 0 && l === 0) {
    return [{ text: 'Nothing new ✨', silent: true, linkPreview: noPreview }];
  }

  const parts: string[] = [];
  if (b > 0) parts.push(`${b} new bookmark${pluralS(b)} 🔖`);
  if (l > 0) parts.push(`${l} new like${pluralS(l)} ❤️`);

  const messages: OutgoingMessage[] = [
    { text: `☀️ This morning: ${parts.join(', ')}`, silent: false, linkPreview: noPreview },
  ];
  for (const tweet of diff.newBookmarks) messages.push(tweetMessage('🔖', tweet));
  for (const tweet of diff.newLikes) messages.push(tweetMessage('❤️', tweet));
  return messages;
}

/**
 * Sends the digest: notifying recap then one silent message per tweet
 * (bookmarks first). First run and empty days: a single silent message.
 */
export async function sendDigest(config: Config, diff: DigestDiff, deps: TelegramDeps = {}): Promise<void> {
  await sendAll(config, buildDigestMessages(diff), deps);
}

/**
 * NOTIFYING failure alert. Never throws: it's the last resort of the global
 * catch — a send failure is only logged to the console.
 */
export async function sendErrorAlert(config: Config, error: unknown, deps: TelegramDeps = {}): Promise<void> {
  const detail = error instanceof Error ? error.message : String(error);
  const text = `⚠️ The bookmark-reminder bot failed: ${escapeHtml(truncate(detail, ERROR_EXCERPT_MAX))}`;
  try {
    await sendAll(config, [{ text, silent: false, linkPreview: { is_disabled: true } }], deps);
  } catch (sendError) {
    console.error('Failed to send the Telegram alert (last resort):', sendError);
  }
}
