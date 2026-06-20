// Tests of the runDigest core: in-memory storage, Telegram/Anthropic fetch
// injected (like telegram.test.ts). Only the X call goes through the global
// fetch (non-injectable): it is stubbed then restored around each scenario.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDigest } from '../src/run.ts';
import type { Storage } from '../src/storage.ts';
import type { BotState, Config, Tokens } from '../src/types.ts';

const config: Config = {
  xClientId: 'client-id',
  xClientSecret: null,
  telegramBotToken: 'TEST_TOKEN',
  telegramChatId: '4242',
  maxResults: 25,
  tweetLinkDomain: 'x.com',
  reauthHint: 're-run `npm run auth`',
  anthropicApiKey: 'sk-ant-test',
  anthropicModel: 'claude-opus-4-8',
};

/** In-memory storage: valid tokens (no network refresh), injected state. */
function makeStorage(initialState: BotState | null) {
  const tokens: Tokens = {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + 3_600_000, // far in the future: no refresh
    userId: '42',
  };
  const putStates: BotState[] = [];
  const storage: Storage = {
    getTokens: async () => tokens,
    putTokens: async () => {},
    getState: async () => initialState,
    putState: async (state) => {
      putStates.push(state);
    },
  };
  return { storage, putStates };
}

/** Empty "yesterday" state: every tweet returned by X is a new item. */
function emptyState(): BotState {
  return { bookmarkIds: [], likeIds: [], lastRunAt: '2026-06-12T07:00:00.000Z' };
}

/** X v2 response (bookmarks or liked_tweets) with n tweets of prefixed ids. */
function xResponse(prefix: string, n: number): Response {
  const data = [];
  for (let i = 1; i <= n; i += 1) {
    data.push({
      id: `${prefix}${i}`,
      text: `tweet ${prefix}${i}`,
      author_id: 'u1',
      created_at: '2026-06-11T09:00:00.000Z',
    });
  }
  return new Response(
    JSON.stringify({
      data,
      includes: { users: [{ id: 'u1', username: 'alice', name: 'Alice' }] },
    }),
    { status: 200 },
  );
}

/** Stubs the global fetch (X calls only) for the duration of the scenario,
 * then restores it even on failure. bookmarks/likes: number of tweets served. */
async function withFetchX(
  count: { bookmarks: number; likes: number },
  scenario: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/bookmarks')) return xResponse('b', count.bookmarks);
    if (url.includes('/liked_tweets')) return xResponse('l', count.likes);
    throw new Error(`unexpected global fetch in the test: ${url}`);
  }) as typeof fetch;
  try {
    await scenario();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** Telegram fetch mock: records the sent texts, always replies ok. */
function makeTelegramMock() {
  const texts: string[] = [];
  const fetchFn: typeof fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body)) as { text: string };
    texts.push(payload.text);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  };
  const sleepFn = async (): Promise<void> => {};
  return { texts, fetchFn, sleepFn };
}

/** Anthropic fetch mock: serves a queue of responses, counts the calls. */
function makeAiMock(queue: Response[]) {
  const calls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    calls.push(String(input));
    const next = queue.shift();
    if (next === undefined) throw new Error('AI mock fetch: no response in queue');
    return next;
  };
  return { calls, fetchFn };
}

/** Anthropic response whose text block carries the given structured output. */
function structuredResponse(output: unknown): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify(output) }],
      stop_reason: 'end_turn',
    }),
    { status: 200 },
  );
}

// --- "skipped" status -------------------------------------------------------

test('runDigest without AI key: summary byte-identical to today, no Anthropic call', async () => {
  await withFetchX({ bookmarks: 3, likes: 1 }, async () => {
    const { storage, putStates } = makeStorage(emptyState());
    const telegram = makeTelegramMock();
    const ai = makeAiMock([]);

    const summary = await runDigest(
      { ...config, anthropicApiKey: null },
      storage,
      { fetchFn: telegram.fetchFn, sleepFn: telegram.sleepFn },
      { fetchFn: ai.fetchFn },
    );

    // Current string unchanged: no AI suffix when the status is "skipped"
    assert.match(summary, /^3 new bookmark\(s\), 1 new like\(s\) — \d+\.\d s$/);
    assert.ok(!summary.includes('AI summary'));
    assert.equal(ai.calls.length, 0); // feature off: never a network call
    assert.equal(putStates.length, 1);
  });
});

// --- "failed" status --------------------------------------------------------

test('runDigest AI failed: suffix " — AI summary: failed (…)", digest sent and state persisted', async () => {
  await withFetchX({ bookmarks: 3, likes: 0 }, async () => {
    const { storage, putStates } = makeStorage(emptyState());
    const telegram = makeTelegramMock();
    const ai = makeAiMock([
      new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }), {
        status: 401,
      }),
    ]);

    const summary = await runDigest(
      config,
      storage,
      { fetchFn: telegram.fetchFn, sleepFn: telegram.sleepFn },
      { fetchFn: ai.fetchFn },
    );

    // The summary carries the cause for the local console and wrangler tail
    assert.match(summary, /^3 new bookmark\(s\), 0 new like\(s\) — \d+\.\d s — AI summary: failed \(HTTP 401/);
    // A Claude failure never removes the digest nor blocks putState
    assert.equal(telegram.texts.length, 4); // recap + 3 items
    assert.ok(telegram.texts[0]?.includes('<i>🤖 AI summary unavailable this morning</i>'));
    assert.equal(putStates.length, 1);
  });
});

// --- "ok" status ------------------------------------------------------------

test('runDigest AI ok: suffix " — AI summary: ok" and enriched recap', async () => {
  await withFetchX({ bookmarks: 3, likes: 0 }, async () => {
    const { storage, putStates } = makeStorage(emptyState());
    const telegram = makeTelegramMock();
    const ai = makeAiMock([
      structuredResponse({
        summary: 'Theme of the day: AI agents.',
        topPicks: [{ index: 1, reason: 'the densest' }],
      }),
    ]);

    const summary = await runDigest(
      config,
      storage,
      { fetchFn: telegram.fetchFn, sleepFn: telegram.sleepFn },
      { fetchFn: ai.fetchFn },
    );

    assert.match(summary, /^3 new bookmark\(s\), 0 new like\(s\) — \d+\.\d s — AI summary: ok$/);
    assert.equal(ai.calls.length, 1); // a single attempt, never a retry
    const recap = telegram.texts[0] ?? '';
    assert.ok(recap.includes('🧠 Theme of the day: AI agents.'));
    assert.ok(recap.includes('⭐ Read first:'));
    // URL resolved client-side from the diff, never coming from the model
    assert.ok(recap.includes('• <b>@alice</b> — the densest\nhttps://x.com/alice/status/b1'));
    assert.equal(putStates.length, 1);
  });
});
