// Pure tests for the Telegram sender: no network, fetch and sleep injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMessage, escapeHtml, sendDigest, sendErrorAlert } from '../src/telegram.ts';
import type { Config, DigestDiff, Tweet } from '../src/types.ts';

const config: Config = {
  xClientId: 'client-id',
  xClientSecret: null,
  telegramBotToken: 'TEST_TOKEN',
  telegramChatId: '4242',
  maxResults: 25,
  tweetLinkDomain: 'x.com',
  reauthHint: 're-run `npm run auth`',
};

interface SentPayload {
  chat_id: string;
  text: string;
  parse_mode: string;
  disable_notification: boolean;
  link_preview_options: { is_disabled?: boolean; url?: string; prefer_large_media?: boolean };
}

function telegramOk(): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
}

/** Mock fetch/sleep: records the payloads, serves a queue of responses. */
function makeMock(queue: Response[] = []) {
  const calls: { url: string; payload: SentPayload }[] = [];
  const sleeps: number[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), payload: JSON.parse(String(init?.body)) as SentPayload });
    return queue.shift() ?? telegramOk();
  };
  const sleepFn = async (ms: number): Promise<void> => {
    sleeps.push(ms);
  };
  return { calls, sleeps, fetchFn, sleepFn };
}

function tweet(id: string, text: string): Tweet {
  return {
    id,
    text,
    authorUsername: 'alice',
    authorName: 'Alice & Co <3>',
    createdAt: '2026-06-11T09:00:00.000Z',
    url: `https://x.com/alice/status/${id}`,
  };
}

function diff(partial: Partial<DigestDiff>): DigestDiff {
  return {
    newBookmarks: [],
    newLikes: [],
    isFirstRun: false,
    trackedCounts: { bookmarks: 0, likes: 0 },
    ...partial,
  };
}

// --- escapeHtml ---------------------------------------------------------

test('escapeHtml escapes & < > and nothing else', () => {
  assert.equal(escapeHtml('a & b <c> "d"'), 'a &amp; b &lt;c&gt; "d"');
  assert.equal(escapeHtml('already &amp;'), 'already &amp;amp;'); // no double interpretation
  assert.equal(escapeHtml(''), '');
});

// --- chunkMessage -------------------------------------------------------

test('chunkMessage leaves intact text shorter than max', () => {
  assert.deepEqual(chunkMessage('court', 100), ['court']);
});

test('chunkMessage splits preferably on a newline', () => {
  const s = 'ligne-1\nligne-2\nligne-3';
  const chunks = chunkMessage(s, 16);
  assert.deepEqual(chunks, ['ligne-1\nligne-2', 'ligne-3']);
});

test('chunkMessage still splits text without a newline', () => {
  const s = 'a'.repeat(25);
  const chunks = chunkMessage(s, 10);
  assert.deepEqual(chunks, ['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
  assert.equal(chunks.join(''), s);
});

test('chunkMessage never produces an empty chunk', () => {
  const chunks = chunkMessage('a\nb\n\n\nc', 1);
  assert.deepEqual(chunks, ['a', 'b', 'c']);
  for (const chunk of chunks) assert.ok(chunk.length > 0);
});

test('chunkMessage does not cut in the middle of an HTML entity', () => {
  const s = 'aaaaaaaa&amp;bbbb'; // a hard cut at 10 would fall inside &amp;
  const chunks = chunkMessage(s, 10);
  assert.deepEqual(chunks, ['aaaaaaaa', '&amp;bbbb']);
});

// --- sendDigest: normal digest -------------------------------------------

test('sendDigest sends a notifying recap then one silent item per tweet', async () => {
  const mock = makeMock();
  const d = diff({
    newBookmarks: [tweet('1', 'first bookmark'), tweet('2', 'second bookmark')],
    newLikes: [tweet('3', 'a like')],
  });
  await sendDigest(config, d, { fetchFn: mock.fetchFn, sleepFn: mock.sleepFn });

  assert.equal(mock.calls.length, 4);
  const recap = mock.calls[0];
  assert.ok(recap);
  assert.ok(recap.url.includes('/botTEST_TOKEN/sendMessage'));
  assert.equal(recap.payload.chat_id, '4242');
  assert.equal(recap.payload.parse_mode, 'HTML');
  assert.equal(recap.payload.disable_notification, false);
  assert.deepEqual(recap.payload.link_preview_options, { is_disabled: true });
  assert.ok(recap.payload.text.includes('2 new bookmarks 🔖'));
  assert.ok(recap.payload.text.includes('1 new like ❤️'));

  const firstItem = mock.calls[1];
  assert.ok(firstItem);
  assert.equal(firstItem.payload.disable_notification, true);
  assert.ok(firstItem.payload.text.startsWith('🔖 <b>Alice &amp; Co &lt;3&gt; @alice</b>'));
  assert.ok(firstItem.payload.text.endsWith('\n\nhttps://x.com/alice/status/1'));
  assert.deepEqual(firstItem.payload.link_preview_options, {
    url: 'https://x.com/alice/status/1',
    prefer_large_media: true,
  });

  const likeItem = mock.calls[3];
  assert.ok(likeItem);
  assert.ok(likeItem.payload.text.startsWith('❤️ '));
  assert.equal(likeItem.payload.link_preview_options.url, 'https://x.com/alice/status/3');

  // throttle between each message (not before the first)
  assert.deepEqual(mock.sleeps, [1100, 1100, 1100]);
});

// --- sendDigest: first run -----------------------------------------------

test('sendDigest first run: a single silent baseline message', async () => {
  const mock = makeMock();
  // Real shape produced by computeDiff(null, …): EMPTY lists of new items,
  // only the counters carry what was recorded.
  const d = diff({
    isFirstRun: true,
    trackedCounts: { bookmarks: 2, likes: 1 },
  });
  await sendDigest(config, d, { fetchFn: mock.fetchFn, sleepFn: mock.sleepFn });

  assert.equal(mock.calls.length, 1);
  const call = mock.calls[0];
  assert.ok(call);
  assert.equal(call.payload.disable_notification, true);
  assert.ok(call.payload.text.includes('2 bookmarks'));
  assert.ok(call.payload.text.includes('1 like'));
  assert.deepEqual(call.payload.link_preview_options, { is_disabled: true });
});

// --- sendDigest: nothing new ----------------------------------------------

test('sendDigest with no new items: a single silent "Nothing new ✨"', async () => {
  const mock = makeMock();
  await sendDigest(config, diff({}), { fetchFn: mock.fetchFn, sleepFn: mock.sleepFn });

  assert.equal(mock.calls.length, 1);
  const call = mock.calls[0];
  assert.ok(call);
  assert.equal(call.payload.text, 'Nothing new ✨');
  assert.equal(call.payload.disable_notification, true);
  assert.deepEqual(call.payload.link_preview_options, { is_disabled: true });
});

// --- 429 → retry ----------------------------------------------------------

test('HTTP 429: waits parameters.retry_after then retries once', async () => {
  const tooMany = new Response(
    JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 3 } }),
    { status: 429 },
  );
  const mock = makeMock([tooMany, telegramOk()]);
  await sendDigest(config, diff({}), { fetchFn: mock.fetchFn, sleepFn: mock.sleepFn });

  assert.equal(mock.calls.length, 2);
  const firstTry = mock.calls[0];
  const retry = mock.calls[1];
  assert.ok(firstTry);
  assert.ok(retry);
  assert.equal(firstTry.payload.text, retry.payload.text); // same message replayed
  assert.deepEqual(mock.sleeps, [3000]);
});

test('non-2xx other than 429: throws with the body description', async () => {
  const forbidden = new Response(
    JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked' }),
    { status: 403 },
  );
  const mock = makeMock([forbidden]);
  await assert.rejects(
    sendDigest(config, diff({}), { fetchFn: mock.fetchFn, sleepFn: mock.sleepFn }),
    /403.*bot was blocked/s,
  );
});

// --- sendErrorAlert --------------------------------------------------------

test('sendErrorAlert sends a notifying alert with the escaped message', async () => {
  const mock = makeMock();
  await sendErrorAlert(config, new Error('refresh <token> & co'), {
    fetchFn: mock.fetchFn,
    sleepFn: mock.sleepFn,
  });

  assert.equal(mock.calls.length, 1);
  const call = mock.calls[0];
  assert.ok(call);
  assert.equal(call.payload.disable_notification, false);
  assert.ok(call.payload.text.startsWith('⚠️ The bookmark-reminder bot failed: '));
  assert.ok(call.payload.text.includes('refresh &lt;token&gt; &amp; co'));
});

test('sendErrorAlert never throws, even if the send fails', async () => {
  const fetchFn: typeof fetch = async () => {
    throw new Error('network down');
  };
  const sleepFn = async (): Promise<void> => {};
  await sendErrorAlert(config, new Error('boom'), { fetchFn, sleepFn }); // must not reject
});
