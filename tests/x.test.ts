import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeApiEntities, mapTweets } from '../src/x.ts';

// Fixture réaliste : forme de GET /2/users/:id/bookmarks avec expansions.
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

test('mapTweets : réponse pleine avec includes', () => {
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
  // L'ordre de l'API est conservé (plus récents en premier).
  assert.equal(tweets[1]?.id, '1799876543210987654');
  assert.equal(tweets[1]?.url, 'https://x.com/typescript/status/1799876543210987654');
});

test('mapTweets : réponse vide (data absent, meta.result_count=0)', () => {
  const tweets = mapTweets({ meta: { result_count: 0 } }, 'x.com');
  assert.deepEqual(tweets, []);
});

test('mapTweets : auteur manquant dans includes → Inconnu + URL /i/status', () => {
  const payload = {
    data: [
      {
        id: '1790000000000000001',
        text: 'tweet orphelin',
        author_id: '999999',
        created_at: '2026-06-01T00:00:00.000Z',
      },
    ],
    includes: { users: [{ id: '44196397', name: 'Elon Musk', username: 'elonmusk' }] },
    meta: { result_count: 1 },
  };
  const tweets = mapTweets(payload, 'x.com');
  assert.equal(tweets[0]?.authorUsername, 'i');
  assert.equal(tweets[0]?.authorName, 'Inconnu');
  assert.equal(tweets[0]?.url, 'https://x.com/i/status/1790000000000000001');
});

test('mapTweets : includes totalement absent → Inconnu', () => {
  const payload = {
    data: [{ id: '42', text: 'sans includes', author_id: '1' }],
    meta: { result_count: 1 },
  };
  const tweets = mapTweets(payload, 'x.com');
  assert.equal(tweets[0]?.authorName, 'Inconnu');
  assert.equal(tweets[0]?.url, 'https://x.com/i/status/42');
});

test('mapTweets : created_at absent → chaîne vide', () => {
  const payload = {
    data: [{ id: '42', text: 'sans date', author_id: '44196397' }],
    includes: { users: [{ id: '44196397', name: 'Elon Musk', username: 'elonmusk' }] },
    meta: { result_count: 1 },
  };
  assert.equal(mapTweets(payload, 'x.com')[0]?.createdAt, '');
});

test('decodeApiEntities : décode & < > et eux seuls, &amp; en dernier', () => {
  assert.equal(decodeApiEntities('R&amp;D &lt;3 a -&gt; b'), 'R&D <3 a -> b');
  // texte contenant littéralement « &lt; » (double-encodé par l'API)
  assert.equal(decodeApiEntities('&amp;lt;'), '&lt;');
  assert.equal(decodeApiEntities('&quot;intact&quot;'), '&quot;intact&quot;');
  assert.equal(decodeApiEntities('sans entité'), 'sans entité');
});

test('mapTweets : décode les entités HTML renvoyées par l’API (text et name)', () => {
  const payload = {
    data: [
      {
        id: '77',
        text: 'Q&amp;A sur la R&amp;D : a &lt; b &amp;&amp; b &gt; c &lt;3',
        author_id: '1',
        created_at: '2026-06-01T00:00:00.000Z',
      },
    ],
    includes: { users: [{ id: '1', name: 'Bell &amp; Labs', username: 'bell' }] },
    meta: { result_count: 1 },
  };
  const tweets = mapTweets(payload, 'x.com');
  assert.equal(tweets[0]?.text, 'Q&A sur la R&D : a < b && b > c <3');
  assert.equal(tweets[0]?.authorName, 'Bell & Labs');
});

test('mapTweets : domaine custom fixupx.com', () => {
  const tweets = mapTweets(fullPayload, 'fixupx.com');
  assert.equal(tweets[0]?.url, 'https://fixupx.com/elonmusk/status/1801234567890123456');
});

test('mapTweets : payload inattendu → throw explicite', () => {
  assert.throws(() => mapTweets(null, 'x.com'), /Réponse X inattendue/);
  assert.throws(() => mapTweets('oops', 'x.com'), /Réponse X inattendue/);
  assert.throws(() => mapTweets({ data: 'pas un tableau' }, 'x.com'), /Réponse X inattendue/);
  assert.throws(
    () => mapTweets({ data: [{ id: 42, text: 'id numérique' }] }, 'x.com'),
    /tweet invalide/,
  );
  assert.throws(
    () => mapTweets({ data: [], includes: { users: [{ id: '1' }] } }, 'x.com'),
    /includes\.users/,
  );
});
