// Pure tests of the AI module: no network, fetch injected (like telegram.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, dedupeTweets, enrichDigest, parseResponse } from '../src/ai.ts';
import type { UniqueTweet } from '../src/ai.ts';
import { escapeHtml } from '../src/telegram.ts';
import type { Config, DigestDiff, Tweet } from '../src/types.ts';

const config: Config = {
  xClientId: 'client-id',
  xClientSecret: null,
  telegramBotToken: 'TEST_TOKEN',
  telegramChatId: '4242',
  maxResults: 25,
  tweetLinkDomain: 'x.com',
  reauthHint: 'relance `npm run auth`',
  anthropicApiKey: 'sk-ant-test',
  anthropicModel: 'claude-opus-4-8',
};

/** Shape of the request body sent to the Anthropic API (fields consumed here). */
interface AnthropicPayload {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: string; content: string }[];
  output_config: { format: { type: string; schema: Record<string, unknown> } };
}

/** Mock fetch: records URL/headers/payload, serves a queue of responses. */
function makeMock(queue: Response[] = []) {
  const calls: { url: string; headers: Record<string, string>; payload: AnthropicPayload }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      payload: JSON.parse(String(init?.body)) as AnthropicPayload,
    });
    const next = queue.shift();
    if (next === undefined) throw new Error('mock fetch: no response in queue');
    return next;
  };
  return { calls, fetchFn };
}

/** Anthropic response whose text block carries the given structured output. */
function structuredResponse(output: unknown, stopReason = 'end_turn'): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify(output) }],
      stop_reason: stopReason,
    }),
    { status: 200 },
  );
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

/** Diff with n unique bookmarks of ids '1'..'n'. */
function diffWithUniques(n: number): DigestDiff {
  const bookmarks: Tweet[] = [];
  for (let i = 1; i <= n; i += 1) bookmarks.push(tweet(String(i), `tweet number ${i}`));
  return diff({ newBookmarks: bookmarks });
}

function unique(t: Tweet, bookmarkedAndLiked = false): UniqueTweet {
  return { tweet: t, bookmarkedAndLiked };
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// --- dedupeTweets ---------------------------------------------------------

test('dedupeTweets merges an id present both as bookmark AND like', () => {
  const uniques = dedupeTweets({
    newBookmarks: [tweet('1', 'first'), tweet('2', 'second')],
    newLikes: [tweet('2', 'second'), tweet('3', 'third')],
  });
  assert.deepEqual(
    uniques.map((u) => u.tweet.id),
    ['1', '2', '3'], // order preserved: bookmarks first, then likes not already seen
  );
  assert.deepEqual(
    uniques.map((u) => u.bookmarkedAndLiked),
    [false, true, false],
  );
});

// --- buildPrompt ----------------------------------------------------------

test('buildPrompt numbers 1..N and includes the author', () => {
  const prompt = buildPrompt([unique(tweet('1', 'some text')), unique(tweet('2', 'other'))]);
  assert.ok(prompt.includes('1. @alice (Alice & Co <3>)\nsome text'));
  assert.ok(prompt.includes('2. @alice (Alice & Co <3>)\nother'));
  assert.ok(prompt.includes('(2)')); // tweet count in the header
});

test('buildPrompt marks the unique entry "bookmarked + liked"', () => {
  const prompt = buildPrompt([unique(tweet('1', 'one'), true), unique(tweet('2', 'two'))]);
  assert.equal(countOccurrences(prompt, '(bookmarked + liked)'), 1);
  assert.ok(prompt.includes('1. @alice (Alice & Co <3>) (bookmarked + liked)'));
});

test('buildPrompt truncates each tweet text to ~2000 chars with a … marker', () => {
  const prompt = buildPrompt([unique(tweet('1', 'a'.repeat(2500)))]);
  assert.ok(prompt.includes('a'.repeat(2000) + '…'));
  assert.ok(!prompt.includes('a'.repeat(2001)));
});

// --- parseResponse (direct cases) ------------------------------------------

test('parseResponse: non-JSON body → failed', () => {
  const outcome = parseResponse(200, 'not json', []);
  assert.ok(outcome.status === 'failed');
  assert.match(outcome.reason, /non-JSON/);
});

test('parseResponse: no text block → failed', () => {
  const outcome = parseResponse(200, JSON.stringify({ content: [], stop_reason: 'end_turn' }), []);
  assert.ok(outcome.status === 'failed');
  assert.match(outcome.reason, /text block/);
});

// --- enrichDigest: skipped cases (never a network call) ---------------------

test('enrichDigest without API key: skips without calling fetch', async () => {
  const mock = makeMock();
  const outcome = await enrichDigest({ ...config, anthropicApiKey: null }, diffWithUniques(5), {
    fetchFn: mock.fetchFn,
  });
  assert.deepEqual(outcome, { status: 'skipped' });
  assert.equal(mock.calls.length, 0);
});

test('enrichDigest on the first run: skips without calling fetch', async () => {
  const mock = makeMock();
  const d = { ...diffWithUniques(5), isFirstRun: true };
  const outcome = await enrichDigest(config, d, { fetchFn: mock.fetchFn });
  assert.deepEqual(outcome, { status: 'skipped' });
  assert.equal(mock.calls.length, 0);
});

test('enrichDigest under 3 UNIQUE tweets: skips without calling fetch', async () => {
  const mock = makeMock();
  // 3 raw entries but 2 unique: id 2 is bookmarked AND liked.
  const d = diff({
    newBookmarks: [tweet('1', 'first'), tweet('2', 'second')],
    newLikes: [tweet('2', 'second')],
  });
  const outcome = await enrichDigest(config, d, { fetchFn: mock.fetchFn });
  assert.deepEqual(outcome, { status: 'skipped' });
  assert.equal(mock.calls.length, 0);
});

// --- enrichDigest: nominal -------------------------------------------------

test('enrichDigest nominal: summary + picks resolved by index, conforming request', async () => {
  const mock = makeMock([
    structuredResponse({
      summary: 'Two themes: AI agents and TypeScript.',
      topPicks: [
        { index: 2, reason: 'the densest' },
        { index: 4, reason: 'complete tutorial' },
      ],
    }),
  ]);
  const outcome = await enrichDigest(config, diffWithUniques(5), { fetchFn: mock.fetchFn });

  assert.ok(outcome.status === 'ok');
  assert.equal(outcome.summary, 'Two themes: AI agents and TypeScript.');
  assert.equal(outcome.picks.length, 2);
  // index→tweet resolution client-side: the URL comes from the diff, not the model.
  assert.equal(outcome.picks[0]?.tweet.id, '2');
  assert.equal(outcome.picks[0]?.tweet.url, 'https://x.com/alice/status/2');
  assert.equal(outcome.picks[0]?.reason, 'the densest');
  assert.equal(outcome.picks[1]?.tweet.id, '4');

  assert.equal(mock.calls.length, 1); // a single attempt, never a retry
  const call = mock.calls[0];
  assert.ok(call);
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.headers['x-api-key'], 'sk-ant-test');
  assert.equal(call.headers['anthropic-version'], '2023-06-01');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.equal(call.payload.model, 'claude-opus-4-8');
  assert.equal(call.payload.max_tokens, 700);
  assert.ok(call.payload.system.includes('DATA')); // tweets = data, not instructions
  assert.ok(call.payload.system.includes('English'));
  assert.equal(call.payload.messages.length, 1);
  assert.equal(call.payload.messages[0]?.role, 'user');
  assert.ok(call.payload.messages[0]?.content.includes('1. @alice'));
  assert.ok(call.payload.messages[0]?.content.includes('5. @alice'));
  assert.equal(call.payload.output_config.format.type, 'json_schema');
  assert.equal(call.payload.output_config.format.schema.additionalProperties, false);
});

test('enrichDigest sends neither temperature, nor top_p, nor top_k, nor thinking', async () => {
  const mock = makeMock([structuredResponse({ summary: 'ok', topPicks: [] })]);
  await enrichDigest(config, diffWithUniques(3), { fetchFn: mock.fetchFn });

  const call = mock.calls[0];
  assert.ok(call);
  const keys = Object.keys(call.payload);
  for (const forbidden of ['temperature', 'top_p', 'top_k', 'thinking']) {
    assert.ok(!keys.includes(forbidden), `forbidden parameter sent: ${forbidden}`);
  }
});

test('enrichDigest dedupes bookmark+like: a single marked entry in the prompt', async () => {
  const mock = makeMock([structuredResponse({ summary: 'ok', topPicks: [] })]);
  const d = diff({
    newBookmarks: [tweet('1', 'tweet number 1'), tweet('2', 'tweet number 2'), tweet('3', 'tweet number 3')],
    newLikes: [tweet('2', 'tweet number 2')],
  });
  const outcome = await enrichDigest(config, d, { fetchFn: mock.fetchFn });

  assert.equal(outcome.status, 'ok'); // 3 uniques: the threshold is indeed reached
  const prompt = mock.calls[0]?.payload.messages[0]?.content ?? '';
  assert.equal(countOccurrences(prompt, 'tweet number 2'), 1);
  assert.equal(countOccurrences(prompt, '(bookmarked + liked)'), 1);
  assert.ok(prompt.includes('2. @alice (Alice & Co <3>) (bookmarked + liked)'));
});

// --- enrichDigest: fail-open failures ----------------------------------------

test('HTTP 529 → failed with the status and body in the reason', async () => {
  const overloaded = new Response(
    JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
    { status: 529 },
  );
  const mock = makeMock([overloaded]);
  const outcome = await enrichDigest(config, diffWithUniques(3), { fetchFn: mock.fetchFn });

  assert.ok(outcome.status === 'failed');
  assert.match(outcome.reason, /HTTP 529 — .*overloaded_error/);
  assert.equal(mock.calls.length, 1); // no retry, even on 529
});

test('fetch that rejects (timeout/abort) → failed, never a throw', async () => {
  const fetchFn: typeof fetch = async () => {
    throw new Error('The operation was aborted due to timeout');
  };
  const outcome = await enrichDigest(config, diffWithUniques(3), { fetchFn });
  assert.ok(outcome.status === 'failed');
  assert.match(outcome.reason, /timeout/);
});

test('stop_reason max_tokens (output cut off) → failed', async () => {
  const mock = makeMock([structuredResponse({ summary: 'truncated', topPicks: [] }, 'max_tokens')]);
  const outcome = await enrichDigest(config, diffWithUniques(3), { fetchFn: mock.fetchFn });
  assert.ok(outcome.status === 'failed');
  assert.match(outcome.reason, /unexpected stop_reason: max_tokens/);
});

test('unknown stop_reason → failed (exhaustive predicate)', async () => {
  const mock = makeMock([structuredResponse({ summary: 'ok', topPicks: [] }, 'mysterious_pause')]);
  const outcome = await enrichDigest(config, diffWithUniques(3), { fetchFn: mock.fetchFn });
  assert.ok(outcome.status === 'failed');
  assert.match(outcome.reason, /unexpected stop_reason: mysterious_pause/);
});

test('partial/invalid output JSON → failed', async () => {
  const truncated = new Response(
    JSON.stringify({
      content: [{ type: 'text', text: '{"summary": "cut' }],
      stop_reason: 'end_turn',
    }),
    { status: 200 },
  );
  const mock = makeMock([truncated]);
  const outcome = await enrichDigest(config, diffWithUniques(3), { fetchFn: mock.fetchFn });
  assert.ok(outcome.status === 'failed');
  assert.match(outcome.reason, /invalid JSON/);
});

test('empty or blank summary → failed', async () => {
  const mock = makeMock([structuredResponse({ summary: '   ', topPicks: [{ index: 1, reason: 'x' }] })]);
  const outcome = await enrichDigest(config, diffWithUniques(3), { fetchFn: mock.fetchFn });
  assert.ok(outcome.status === 'failed');
  assert.match(outcome.reason, /empty summary/);
});

// --- caps applied in the parser ----------------------------------------------

test('out-of-range, non-integer or duplicate indices: picks ignored', async () => {
  const mock = makeMock([
    structuredResponse({
      summary: 'ok',
      topPicks: [
        { index: 0, reason: 'out of range low' },
        { index: 99, reason: 'out of range high' },
        { index: 2.5, reason: 'non-integer' },
        { index: 2, reason: 'valid' },
        { index: 2, reason: 'duplicate' },
      ],
    }),
  ]);
  const outcome = await enrichDigest(config, diffWithUniques(5), { fetchFn: mock.fetchFn });

  assert.ok(outcome.status === 'ok');
  assert.equal(outcome.picks.length, 1);
  assert.equal(outcome.picks[0]?.tweet.id, '2');
  assert.equal(outcome.picks[0]?.reason, 'valid');
});

test('no valid pick: ok anyway, picks block omitted (empty list)', async () => {
  const mock = makeMock([
    structuredResponse({ summary: 'summary only', topPicks: [{ index: 42, reason: 'lost' }] }),
  ]);
  const outcome = await enrichDigest(config, diffWithUniques(3), { fetchFn: mock.fetchFn });

  assert.ok(outcome.status === 'ok');
  assert.equal(outcome.summary, 'summary only');
  assert.deepEqual(outcome.picks, []);
});

test('more than 3 valid picks: truncated to 3, in the model order', async () => {
  const mock = makeMock([
    structuredResponse({
      summary: 'ok',
      topPicks: [1, 2, 3, 4, 5].map((index) => ({ index, reason: `reason ${index}` })),
    }),
  ]);
  const outcome = await enrichDigest(config, diffWithUniques(5), { fetchFn: mock.fetchFn });

  assert.ok(outcome.status === 'ok');
  assert.deepEqual(
    outcome.picks.map((p) => p.tweet.id),
    ['1', '2', '3'],
  );
});

test('summary and reasons capped at ~600 and ~150 chars in the parser', async () => {
  const mock = makeMock([
    structuredResponse({
      summary: 'r'.repeat(1000),
      topPicks: [{ index: 1, reason: 'x'.repeat(400) }],
    }),
  ]);
  const outcome = await enrichDigest(config, diffWithUniques(3), { fetchFn: mock.fetchFn });

  assert.ok(outcome.status === 'ok');
  assert.equal(outcome.summary, 'r'.repeat(600) + '…');
  assert.equal(outcome.picks[0]?.reason, 'x'.repeat(150) + '…');
});

test('caps measured AFTER HTML escaping: summary/reason saturated with & shortened', async () => {
  // '&' becomes '&amp;' (5 chars) on render: measuring the raw text would let
  // the escaped recap exceed 4096 chars → two notifying messages.
  const mock = makeMock([
    structuredResponse({
      summary: '&'.repeat(1000),
      topPicks: [{ index: 1, reason: '&'.repeat(400) }],
    }),
  ]);
  const outcome = await enrichDigest(config, diffWithUniques(3), { fetchFn: mock.fetchFn });

  assert.ok(outcome.status === 'ok');
  assert.equal(outcome.summary, '&'.repeat(120) + '…'); // 120 × 5 = 600 escaped chars
  assert.equal(escapeHtml(outcome.summary).length, 601); // cap + marker, as for 'r'
  assert.equal(outcome.picks[0]?.reason, '&'.repeat(30) + '…'); // 30 × 5 = 150 escaped chars
  assert.equal(escapeHtml(outcome.picks[0]?.reason ?? '').length, 151);
});

test('plain-text URLs from the model are defanged in summary and reasons', async () => {
  // Telegram auto-links any plain-text URL: without defang, a prompt injection
  // would place a clickable phishing link in the recap.
  const mock = makeMock([
    structuredResponse({
      summary: 'Go see HTTPS://evil.example and http://phish.example for the rest.',
      topPicks: [{ index: 1, reason: 'details at https://evil.example/payload' }],
    }),
  ]);
  const outcome = await enrichDigest(config, diffWithUniques(3), { fetchFn: mock.fetchFn });

  assert.ok(outcome.status === 'ok');
  assert.ok(!/https?:\/\//i.test(outcome.summary));
  assert.equal(outcome.summary, 'Go see hxxp://evil.example and hxxp://phish.example for the rest.');
  assert.equal(outcome.picks[0]?.reason, 'details at hxxp://evil.example/payload');
});
