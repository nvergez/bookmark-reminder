import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeApiEntities, mapTweets } from '../src/x.ts';

// Realistic fixture: shape of GET /2/users/:id/bookmarks with expansions.
const fullPayload = {
  data: [
    {
      id: '1801234567890123456',
      text: 'Ship it. 🚀',
      author_id: '44196397',
      created_at: '2026-06-10T14:32:05.000Z',
      edit_history_tweet_ids: ['1801234567890123456'],
    },
    {
      id: '1799876543210987654',
      text: 'TypeScript 6.0 beta is out — native type stripping everywhere.',
      author_id: '809233214',
      created_at: '2026-06-08T09:01:44.000Z',
      edit_history_tweet_ids: ['1799876543210987654'],
    },
  ],
  includes: {
    users: [
      { id: '44196397', name: 'Elon Musk', username: 'elonmusk' },
      { id: '809233214', name: 'TypeScript', username: 'typescript' },
    ],
  },
  meta: {
    result_count: 2,
    next_token: '7140dibdnow9c7btw482tsd6eqzkq6kanq7c1gnpc4zmu',
  },
};

test('mapTweets: full response with includes', () => {
  const tweets = mapTweets(fullPayload, 'x.com');
  assert.equal(tweets.length, 2);
  assert.deepEqual(tweets[0], {
    id: '1801234567890123456',
    text: 'Ship it. 🚀',
    authorUsername: 'elonmusk',
    authorName: 'Elon Musk',
    createdAt: '2026-06-10T14:32:05.000Z',
    url: 'https://x.com/elonmusk/status/1801234567890123456',
  });
  // The API order is preserved (most recent first).
  assert.equal(tweets[1]?.id, '1799876543210987654');
  assert.equal(tweets[1]?.url, 'https://x.com/typescript/status/1799876543210987654');
});

test('mapTweets: empty response (data missing, meta.result_count=0)', () => {
  const tweets = mapTweets({ meta: { result_count: 0 } }, 'x.com');
  assert.deepEqual(tweets, []);
});

test('mapTweets: author missing from includes → Unknown + /i/status URL', () => {
  const payload = {
    data: [
      {
        id: '1790000000000000001',
        text: 'orphan tweet',
        author_id: '999999',
        created_at: '2026-06-01T00:00:00.000Z',
      },
    ],
    includes: { users: [{ id: '44196397', name: 'Elon Musk', username: 'elonmusk' }] },
    meta: { result_count: 1 },
  };
  const tweets = mapTweets(payload, 'x.com');
  assert.equal(tweets[0]?.authorUsername, 'i');
  assert.equal(tweets[0]?.authorName, 'Unknown');
  assert.equal(tweets[0]?.url, 'https://x.com/i/status/1790000000000000001');
});

test('mapTweets: includes completely missing → Unknown', () => {
  const payload = {
    data: [{ id: '42', text: 'no includes', author_id: '1' }],
    meta: { result_count: 1 },
  };
  const tweets = mapTweets(payload, 'x.com');
  assert.equal(tweets[0]?.authorName, 'Unknown');
  assert.equal(tweets[0]?.url, 'https://x.com/i/status/42');
});

test('mapTweets: created_at missing → empty string', () => {
  const payload = {
    data: [{ id: '42', text: 'no date', author_id: '44196397' }],
    includes: { users: [{ id: '44196397', name: 'Elon Musk', username: 'elonmusk' }] },
    meta: { result_count: 1 },
  };
  assert.equal(mapTweets(payload, 'x.com')[0]?.createdAt, '');
});

test('decodeApiEntities: decodes & < > and only those, &amp; last', () => {
  assert.equal(decodeApiEntities('R&amp;D &lt;3 a -&gt; b'), 'R&D <3 a -> b');
  // text literally containing "&lt;" (double-encoded by the API)
  assert.equal(decodeApiEntities('&amp;lt;'), '&lt;');
  assert.equal(decodeApiEntities('&quot;intact&quot;'), '&quot;intact&quot;');
  assert.equal(decodeApiEntities('no entity'), 'no entity');
});

test('mapTweets: decodes the HTML entities returned by the API (text and name)', () => {
  const payload = {
    data: [
      {
        id: '77',
        text: 'Q&amp;A on R&amp;D: a &lt; b &amp;&amp; b &gt; c &lt;3',
        author_id: '1',
        created_at: '2026-06-01T00:00:00.000Z',
      },
    ],
    includes: { users: [{ id: '1', name: 'Bell &amp; Labs', username: 'bell' }] },
    meta: { result_count: 1 },
  };
  const tweets = mapTweets(payload, 'x.com');
  assert.equal(tweets[0]?.text, 'Q&A on R&D: a < b && b > c <3');
  assert.equal(tweets[0]?.authorName, 'Bell & Labs');
});

test('mapTweets: note_tweet present → full text used (and decoded)', () => {
  const payload = {
    data: [
      {
        id: '1810000000000000001',
        text: 'Start of the long post, truncated by the API… https://t.co/abc123',
        note_tweet: {
          text: 'Start of the long post, truncated by the API, then everything beyond the 280 characters — R&amp;D &lt;3 included.',
        },
        author_id: '44196397',
        created_at: '2026-06-11T08:00:00.000Z',
      },
    ],
    includes: { users: [{ id: '44196397', name: 'Elon Musk', username: 'elonmusk' }] },
    meta: { result_count: 1 },
  };
  const tweets = mapTweets(payload, 'x.com');
  // The full text replaces the truncated `text`, entities decoded as for text.
  assert.equal(
    tweets[0]?.text,
    'Start of the long post, truncated by the API, then everything beyond the 280 characters — R&D <3 included.',
  );
});

test('mapTweets: note_tweet absent → text used as-is (behavior unchanged)', () => {
  const tweets = mapTweets(fullPayload, 'x.com');
  assert.equal(tweets[0]?.text, 'Ship it. 🚀');
  assert.equal(
    tweets[1]?.text,
    'TypeScript 6.0 beta is out — native type stripping everywhere.',
  );
});

test('mapTweets: malformed note_tweet → tweet rejected', () => {
  assert.throws(
    () => mapTweets({ data: [{ id: '1', text: 'ok', note_tweet: 'not an object' }] }, 'x.com'),
    /invalid tweet/,
  );
  assert.throws(
    () => mapTweets({ data: [{ id: '1', text: 'ok', note_tweet: { text: 42 } }] }, 'x.com'),
    /invalid tweet/,
  );
  assert.throws(
    () => mapTweets({ data: [{ id: '1', text: 'ok', note_tweet: {} }] }, 'x.com'),
    /invalid tweet/,
  );
});

test('mapTweets: custom domain fixupx.com', () => {
  const tweets = mapTweets(fullPayload, 'fixupx.com');
  assert.equal(tweets[0]?.url, 'https://fixupx.com/elonmusk/status/1801234567890123456');
});

test('mapTweets: unexpected payload → explicit throw', () => {
  assert.throws(() => mapTweets(null, 'x.com'), /Unexpected X response/);
  assert.throws(() => mapTweets('oops', 'x.com'), /Unexpected X response/);
  assert.throws(() => mapTweets({ data: 'not an array' }, 'x.com'), /Unexpected X response/);
  assert.throws(
    () => mapTweets({ data: [{ id: 42, text: 'numeric id' }] }, 'x.com'),
    /invalid tweet/,
  );
  assert.throws(
    () => mapTweets({ data: [], includes: { users: [{ id: '1' }] } }, 'x.com'),
    /includes\.users/,
  );
});
