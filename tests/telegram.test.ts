// Pure tests for the Telegram sender: no network, fetch and sleep injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResponse } from '../src/ai.ts';
import type { AiOutcome } from '../src/ai.ts';
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
  anthropicApiKey: null,
  anthropicModel: 'claude-opus-4-8',
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
  await sendDigest(config, d, { status: 'skipped' }, { fetchFn: mock.fetchFn, sleepFn: mock.sleepFn });

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
  await sendDigest(config, d, { status: 'skipped' }, { fetchFn: mock.fetchFn, sleepFn: mock.sleepFn });

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
  await sendDigest(config, diff({}), { status: 'skipped' }, { fetchFn: mock.fetchFn, sleepFn: mock.sleepFn });

  assert.equal(mock.calls.length, 1);
  const call = mock.calls[0];
  assert.ok(call);
  assert.equal(call.payload.text, 'Nothing new ✨');
  assert.equal(call.payload.disable_notification, true);
  assert.deepEqual(call.payload.link_preview_options, { is_disabled: true });
});

// --- sendDigest: recap enriched by the AI ----------------------------------

const UNAVAILABLE_LINE = '<i>🤖 AI summary unavailable this morning</i>';

test('enriched recap at maximum size: a single chunk, silent: false exactly once', async () => {
  const mock = makeMock();
  const d = diff({
    newBookmarks: [tweet('1', 'first bookmark'), tweet('2', 'second bookmark')],
    newLikes: [tweet('3', 'a like')],
  });
  // REAL worst case out of parseResponse (and not a fabricated outcome):
  // summary and reasons saturated with '&', which quintuples on render
  // ('&amp;'). Caps measured on the raw text would give here an escaped recap
  // > 4096 chars → split into TWO notifying messages.
  const modelBody = JSON.stringify({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          summary: '&'.repeat(1000),
          topPicks: [
            { index: 1, reason: '&'.repeat(400) },
            { index: 2, reason: '&'.repeat(400) },
            { index: 3, reason: '&'.repeat(400) },
          ],
        }),
      },
    ],
    stop_reason: 'end_turn',
  });
  const aiOutcome: AiOutcome = parseResponse(
    200,
    modelBody,
    [...d.newBookmarks, ...d.newLikes].map((t) => ({ tweet: t, bookmarkedAndLiked: false })),
  );
  assert.ok(aiOutcome.status === 'ok');
  assert.equal(aiOutcome.picks.length, 3);
  await sendDigest(config, d, aiOutcome, { fetchFn: mock.fetchFn, sleepFn: mock.sleepFn });

  // 1 recap + 3 items: the recap was NOT split by chunkMessage
  assert.equal(mock.calls.length, 4);
  const recap = mock.calls[0];
  assert.ok(recap);
  assert.equal(chunkMessage(recap.payload.text).length, 1);
  assert.ok(recap.payload.text.length <= 4096); // RENDERED (escaped) text under the Telegram limit
  // Counters FIRST: the notification preview stays useful
  assert.ok(recap.payload.text.startsWith('☀️ This morning: 2 new bookmarks 🔖, 1 new like ❤️'));
  assert.ok(recap.payload.text.includes('\n\n🧠 ' + '&amp;'.repeat(120) + '…'));
  assert.ok(recap.payload.text.includes('\n\n⭐ Read first:'));
  assert.ok(recap.payload.text.includes('\n• <b>@alice</b> — ' + '&amp;'.repeat(30) + '…\nhttps://x.com/alice/status/1'));
  assert.ok(recap.payload.text.includes('\nhttps://x.com/alice/status/3'));
  assert.ok(!recap.payload.text.includes(UNAVAILABLE_LINE)); // never on 'ok'
  // link_preview_options stays disabled on the recap
  assert.deepEqual(recap.payload.link_preview_options, { is_disabled: true });
  // silent: false exactly once (the recap); the items stay silent
  const notifying = mock.calls.filter((call) => !call.payload.disable_notification);
  assert.equal(notifying.length, 1);
  assert.equal(notifying[0], recap);
});

test('unavailability line rendered ONLY when the status is failed', async () => {
  const d = diff({ newBookmarks: [tweet('1', 'first bookmark')] });

  const onFailed = makeMock();
  await sendDigest(config, d, { status: 'failed', reason: 'HTTP 401 — revoked key' }, {
    fetchFn: onFailed.fetchFn,
    sleepFn: onFailed.sleepFn,
  });
  const recapFailed = onFailed.calls[0]?.payload.text ?? '';
  assert.ok(recapFailed.startsWith('☀️ This morning: ')); // counters always first
  assert.ok(recapFailed.endsWith(`\n\n${UNAVAILABLE_LINE}`));
  assert.ok(!recapFailed.includes('HTTP 401')); // the reason stays in the console, not in Telegram

  const onSkipped = makeMock();
  await sendDigest(config, d, { status: 'skipped' }, { fetchFn: onSkipped.fetchFn, sleepFn: onSkipped.sleepFn });
  assert.ok(!(onSkipped.calls[0]?.payload.text ?? '').includes(UNAVAILABLE_LINE));

  const onOk = makeMock();
  await sendDigest(config, d, { status: 'ok', summary: 'summary of the day', picks: [] }, {
    fetchFn: onOk.fetchFn,
    sleepFn: onOk.sleepFn,
  });
  assert.ok(!(onOk.calls[0]?.payload.text ?? '').includes(UNAVAILABLE_LINE));
});

test('enriched recap: author, reason and summary go through escapeHtml', async () => {
  const mock = makeMock();
  const trap: Tweet = { ...tweet('1', 'first bookmark'), authorUsername: 'eve<&>' };
  const aiOutcome: AiOutcome = {
    status: 'ok',
    summary: 'summary <end> & co',
    picks: [{ tweet: trap, reason: 'to <read> & reread' }],
  };
  await sendDigest(config, diff({ newBookmarks: [trap] }), aiOutcome, {
    fetchFn: mock.fetchFn,
    sleepFn: mock.sleepFn,
  });

  const recap = mock.calls[0]?.payload.text ?? '';
  assert.ok(recap.includes('\n\n🧠 summary &lt;end&gt; &amp; co'));
  // The <b> opens and closes on the same line, around the escaped author
  assert.ok(recap.includes('\n• <b>@eve&lt;&amp;&gt;</b> — to &lt;read&gt; &amp; reread\nhttps://x.com/alice/status/1'));
  assert.ok(!recap.includes('@eve<&>')); // never raw HTML coming from the data
});

test('byte-identical digest to today when the status is skipped', async () => {
  const d = diff({
    newBookmarks: [tweet('1', 'first bookmark')],
    newLikes: [tweet('2', 'a like')],
  });
  const onSkipped = makeMock();
  await sendDigest(config, d, { status: 'skipped' }, { fetchFn: onSkipped.fetchFn, sleepFn: onSkipped.sleepFn });
  // Recap strictly identical to the current string: nothing added
  assert.equal(onSkipped.calls[0]?.payload.text, '☀️ This morning: 1 new bookmark 🔖, 1 new like ❤️');

  // The two-argument call (compat) renders exactly the same payloads
  const byDefault = makeMock();
  await sendDigest(config, d, undefined, { fetchFn: byDefault.fetchFn, sleepFn: byDefault.sleepFn });
  assert.deepEqual(
    byDefault.calls.map((call) => call.payload),
    onSkipped.calls.map((call) => call.payload),
  );
});

// --- 429 → retry ----------------------------------------------------------

test('HTTP 429: waits parameters.retry_after then retries once', async () => {
  const tooMany = new Response(
    JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 3 } }),
    { status: 429 },
  );
  const mock = makeMock([tooMany, telegramOk()]);
  await sendDigest(config, diff({}), { status: 'skipped' }, { fetchFn: mock.fetchFn, sleepFn: mock.sleepFn });

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
    sendDigest(config, diff({}), { status: 'skipped' }, { fetchFn: mock.fetchFn, sleepFn: mock.sleepFn }),
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
