// Tests purs du module IA : aucun réseau, fetch injecté (façon telegram.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { construirePrompt, dedupliquerTweets, enrichirDigest, parseReponse } from '../src/ai.ts';
import type { TweetUnique } from '../src/ai.ts';
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

/** Forme du corps de requête envoyé à l'API Anthropic (champs consommés ici). */
interface AnthropicPayload {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: string; content: string }[];
  output_config: { format: { type: string; schema: Record<string, unknown> } };
}

/** Mock fetch : enregistre URL/headers/payload, sert une file de réponses. */
function makeMock(queue: Response[] = []) {
  const calls: { url: string; headers: Record<string, string>; payload: AnthropicPayload }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      payload: JSON.parse(String(init?.body)) as AnthropicPayload,
    });
    const next = queue.shift();
    if (next === undefined) throw new Error('mock fetch : aucune réponse en file');
    return next;
  };
  return { calls, fetchFn };
}

/** Réponse Anthropic dont le bloc texte porte la sortie structurée donnée. */
function reponseStructuree(sortie: unknown, stopReason = 'end_turn'): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify(sortie) }],
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

/** Diff avec n bookmarks uniques d'ids '1'..'n'. */
function diffAvecUniques(n: number): DigestDiff {
  const bookmarks: Tweet[] = [];
  for (let i = 1; i <= n; i += 1) bookmarks.push(tweet(String(i), `tweet numéro ${i}`));
  return diff({ newBookmarks: bookmarks });
}

function unique(t: Tweet, bookmarkEtLike = false): TweetUnique {
  return { tweet: t, bookmarkEtLike };
}

function compterOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// --- dedupliquerTweets ----------------------------------------------------

test('dedupliquerTweets fusionne un id présent en bookmark ET en like', () => {
  const uniques = dedupliquerTweets({
    newBookmarks: [tweet('1', 'premier'), tweet('2', 'second')],
    newLikes: [tweet('2', 'second'), tweet('3', 'troisième')],
  });
  assert.deepEqual(
    uniques.map((u) => u.tweet.id),
    ['1', '2', '3'], // ordre conservé : bookmarks d'abord, puis likes inédits
  );
  assert.deepEqual(
    uniques.map((u) => u.bookmarkEtLike),
    [false, true, false],
  );
});

// --- construirePrompt -----------------------------------------------------

test('construirePrompt numérote 1..N et inclut l’auteur', () => {
  const prompt = construirePrompt([unique(tweet('1', 'un texte')), unique(tweet('2', 'autre'))]);
  assert.ok(prompt.includes('1. @alice (Alice & Co <3>)\nun texte'));
  assert.ok(prompt.includes('2. @alice (Alice & Co <3>)\nautre'));
  assert.ok(prompt.includes('(2)')); // compte des tweets dans l'en-tête
});

test('construirePrompt marque l’entrée unique « bookmarké + liké »', () => {
  const prompt = construirePrompt([unique(tweet('1', 'un'), true), unique(tweet('2', 'deux'))]);
  assert.equal(compterOccurrences(prompt, '(bookmarké + liké)'), 1);
  assert.ok(prompt.includes('1. @alice (Alice & Co <3>) (bookmarké + liké)'));
});

test('construirePrompt tronque chaque texte de tweet à ~2000 chars avec marqueur …', () => {
  const prompt = construirePrompt([unique(tweet('1', 'a'.repeat(2500)))]);
  assert.ok(prompt.includes('a'.repeat(2000) + '…'));
  assert.ok(!prompt.includes('a'.repeat(2001)));
});

// --- parseReponse (cas directs) --------------------------------------------

test('parseReponse : corps non-JSON → echec', () => {
  const outcome = parseReponse(200, 'pas du json', []);
  assert.ok(outcome.statut === 'echec');
  assert.match(outcome.raison, /non-JSON/);
});

test('parseReponse : pas de bloc de texte → echec', () => {
  const outcome = parseReponse(200, JSON.stringify({ content: [], stop_reason: 'end_turn' }), []);
  assert.ok(outcome.statut === 'echec');
  assert.match(outcome.raison, /bloc de texte/);
});

// --- enrichirDigest : cas sautés (jamais d'appel réseau) --------------------

test('enrichirDigest sans clé API : saute sans appeler fetch', async () => {
  const mock = makeMock();
  const outcome = await enrichirDigest({ ...config, anthropicApiKey: null }, diffAvecUniques(5), {
    fetchFn: mock.fetchFn,
  });
  assert.deepEqual(outcome, { statut: 'saute' });
  assert.equal(mock.calls.length, 0);
});

test('enrichirDigest au premier run : saute sans appeler fetch', async () => {
  const mock = makeMock();
  const d = { ...diffAvecUniques(5), isFirstRun: true };
  const outcome = await enrichirDigest(config, d, { fetchFn: mock.fetchFn });
  assert.deepEqual(outcome, { statut: 'saute' });
  assert.equal(mock.calls.length, 0);
});

test('enrichirDigest sous 3 tweets UNIQUES : saute sans appeler fetch', async () => {
  const mock = makeMock();
  // 3 entrées brutes mais 2 uniques : l'id 2 est bookmarké ET liké.
  const d = diff({
    newBookmarks: [tweet('1', 'premier'), tweet('2', 'second')],
    newLikes: [tweet('2', 'second')],
  });
  const outcome = await enrichirDigest(config, d, { fetchFn: mock.fetchFn });
  assert.deepEqual(outcome, { statut: 'saute' });
  assert.equal(mock.calls.length, 0);
});

// --- enrichirDigest : nominal ----------------------------------------------

test('enrichirDigest nominal : résumé + picks résolus par index, requête conforme', async () => {
  const mock = makeMock([
    reponseStructuree({
      resume: 'Deux thèmes : agents IA et TypeScript.',
      topPicks: [
        { index: 2, raison: 'le plus dense' },
        { index: 4, raison: 'tutoriel complet' },
      ],
    }),
  ]);
  const outcome = await enrichirDigest(config, diffAvecUniques(5), { fetchFn: mock.fetchFn });

  assert.ok(outcome.statut === 'ok');
  assert.equal(outcome.resume, 'Deux thèmes : agents IA et TypeScript.');
  assert.equal(outcome.picks.length, 2);
  // Résolution index→tweet côté client : l'URL vient du diff, pas du modèle.
  assert.equal(outcome.picks[0]?.tweet.id, '2');
  assert.equal(outcome.picks[0]?.tweet.url, 'https://x.com/alice/status/2');
  assert.equal(outcome.picks[0]?.raison, 'le plus dense');
  assert.equal(outcome.picks[1]?.tweet.id, '4');

  assert.equal(mock.calls.length, 1); // un seul essai, jamais de retry
  const call = mock.calls[0];
  assert.ok(call);
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.headers['x-api-key'], 'sk-ant-test');
  assert.equal(call.headers['anthropic-version'], '2023-06-01');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.equal(call.payload.model, 'claude-opus-4-8');
  assert.equal(call.payload.max_tokens, 700);
  assert.ok(call.payload.system.includes('DONNÉE')); // tweets = données, pas instructions
  assert.ok(call.payload.system.includes('français'));
  assert.equal(call.payload.messages.length, 1);
  assert.equal(call.payload.messages[0]?.role, 'user');
  assert.ok(call.payload.messages[0]?.content.includes('1. @alice'));
  assert.ok(call.payload.messages[0]?.content.includes('5. @alice'));
  assert.equal(call.payload.output_config.format.type, 'json_schema');
  assert.equal(call.payload.output_config.format.schema.additionalProperties, false);
});

test('enrichirDigest n’envoie ni temperature, ni top_p, ni top_k, ni thinking', async () => {
  const mock = makeMock([reponseStructuree({ resume: 'ok', topPicks: [] })]);
  await enrichirDigest(config, diffAvecUniques(3), { fetchFn: mock.fetchFn });

  const call = mock.calls[0];
  assert.ok(call);
  const cles = Object.keys(call.payload);
  for (const interdite of ['temperature', 'top_p', 'top_k', 'thinking']) {
    assert.ok(!cles.includes(interdite), `paramètre interdit envoyé : ${interdite}`);
  }
});

test('enrichirDigest déduplique bookmark+like : une seule entrée marquée dans le prompt', async () => {
  const mock = makeMock([reponseStructuree({ resume: 'ok', topPicks: [] })]);
  const d = diff({
    newBookmarks: [tweet('1', 'tweet numéro 1'), tweet('2', 'tweet numéro 2'), tweet('3', 'tweet numéro 3')],
    newLikes: [tweet('2', 'tweet numéro 2')],
  });
  const outcome = await enrichirDigest(config, d, { fetchFn: mock.fetchFn });

  assert.equal(outcome.statut, 'ok'); // 3 uniques : le seuil est bien atteint
  const prompt = mock.calls[0]?.payload.messages[0]?.content ?? '';
  assert.equal(compterOccurrences(prompt, 'tweet numéro 2'), 1);
  assert.equal(compterOccurrences(prompt, '(bookmarké + liké)'), 1);
  assert.ok(prompt.includes('2. @alice (Alice & Co <3>) (bookmarké + liké)'));
});

// --- enrichirDigest : échecs fail-open ---------------------------------------

test('HTTP 529 → echec avec le statut et le corps dans la raison', async () => {
  const surcharge = new Response(
    JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
    { status: 529 },
  );
  const mock = makeMock([surcharge]);
  const outcome = await enrichirDigest(config, diffAvecUniques(3), { fetchFn: mock.fetchFn });

  assert.ok(outcome.statut === 'echec');
  assert.match(outcome.raison, /HTTP 529 — .*overloaded_error/);
  assert.equal(mock.calls.length, 1); // pas de retry, même sur 529
});

test('fetch qui rejette (timeout/abort) → echec, jamais de throw', async () => {
  const fetchFn: typeof fetch = async () => {
    throw new Error('The operation was aborted due to timeout');
  };
  const outcome = await enrichirDigest(config, diffAvecUniques(3), { fetchFn });
  assert.ok(outcome.statut === 'echec');
  assert.match(outcome.raison, /timeout/);
});

test('stop_reason max_tokens (sortie coupée) → echec', async () => {
  const mock = makeMock([reponseStructuree({ resume: 'tronqué', topPicks: [] }, 'max_tokens')]);
  const outcome = await enrichirDigest(config, diffAvecUniques(3), { fetchFn: mock.fetchFn });
  assert.ok(outcome.statut === 'echec');
  assert.match(outcome.raison, /stop_reason inattendu : max_tokens/);
});

test('stop_reason inconnu → echec (prédicat exhaustif)', async () => {
  const mock = makeMock([reponseStructuree({ resume: 'ok', topPicks: [] }, 'pause_mysterieuse')]);
  const outcome = await enrichirDigest(config, diffAvecUniques(3), { fetchFn: mock.fetchFn });
  assert.ok(outcome.statut === 'echec');
  assert.match(outcome.raison, /stop_reason inattendu : pause_mysterieuse/);
});

test('JSON de sortie partiel/invalide → echec', async () => {
  const coupe = new Response(
    JSON.stringify({
      content: [{ type: 'text', text: '{"resume": "coup' }],
      stop_reason: 'end_turn',
    }),
    { status: 200 },
  );
  const mock = makeMock([coupe]);
  const outcome = await enrichirDigest(config, diffAvecUniques(3), { fetchFn: mock.fetchFn });
  assert.ok(outcome.statut === 'echec');
  assert.match(outcome.raison, /JSON invalide/);
});

test('résumé vide ou blanc → echec', async () => {
  const mock = makeMock([reponseStructuree({ resume: '   ', topPicks: [{ index: 1, raison: 'x' }] })]);
  const outcome = await enrichirDigest(config, diffAvecUniques(3), { fetchFn: mock.fetchFn });
  assert.ok(outcome.statut === 'echec');
  assert.match(outcome.raison, /résumé vide/);
});

// --- plafonds appliqués dans le parser ---------------------------------------

test('indices hors plage, non entiers ou dupliqués : picks ignorés', async () => {
  const mock = makeMock([
    reponseStructuree({
      resume: 'ok',
      topPicks: [
        { index: 0, raison: 'hors plage bas' },
        { index: 99, raison: 'hors plage haut' },
        { index: 2.5, raison: 'non entier' },
        { index: 2, raison: 'valide' },
        { index: 2, raison: 'dupliqué' },
      ],
    }),
  ]);
  const outcome = await enrichirDigest(config, diffAvecUniques(5), { fetchFn: mock.fetchFn });

  assert.ok(outcome.statut === 'ok');
  assert.equal(outcome.picks.length, 1);
  assert.equal(outcome.picks[0]?.tweet.id, '2');
  assert.equal(outcome.picks[0]?.raison, 'valide');
});

test('aucun pick valide : ok quand même, bloc picks omis (liste vide)', async () => {
  const mock = makeMock([
    reponseStructuree({ resume: 'résumé seul', topPicks: [{ index: 42, raison: 'perdu' }] }),
  ]);
  const outcome = await enrichirDigest(config, diffAvecUniques(3), { fetchFn: mock.fetchFn });

  assert.ok(outcome.statut === 'ok');
  assert.equal(outcome.resume, 'résumé seul');
  assert.deepEqual(outcome.picks, []);
});

test('plus de 3 picks valides : tronqué à 3, dans l’ordre du modèle', async () => {
  const mock = makeMock([
    reponseStructuree({
      resume: 'ok',
      topPicks: [1, 2, 3, 4, 5].map((index) => ({ index, raison: `raison ${index}` })),
    }),
  ]);
  const outcome = await enrichirDigest(config, diffAvecUniques(5), { fetchFn: mock.fetchFn });

  assert.ok(outcome.statut === 'ok');
  assert.deepEqual(
    outcome.picks.map((p) => p.tweet.id),
    ['1', '2', '3'],
  );
});

test('résumé et raisons plafonnés à ~600 et ~150 chars dans le parser', async () => {
  const mock = makeMock([
    reponseStructuree({
      resume: 'r'.repeat(1000),
      topPicks: [{ index: 1, raison: 'x'.repeat(400) }],
    }),
  ]);
  const outcome = await enrichirDigest(config, diffAvecUniques(3), { fetchFn: mock.fetchFn });

  assert.ok(outcome.statut === 'ok');
  assert.equal(outcome.resume, 'r'.repeat(600) + '…');
  assert.equal(outcome.picks[0]?.raison, 'x'.repeat(150) + '…');
});

test('plafonds mesurés APRÈS échappement HTML : résumé/raison saturés de & raccourcis', async () => {
  // '&' devient '&amp;' (5 chars) au rendu : mesurer le texte brut laisserait
  // le récap échappé dépasser 4096 chars → deux messages notifiants.
  const mock = makeMock([
    reponseStructuree({
      resume: '&'.repeat(1000),
      topPicks: [{ index: 1, raison: '&'.repeat(400) }],
    }),
  ]);
  const outcome = await enrichirDigest(config, diffAvecUniques(3), { fetchFn: mock.fetchFn });

  assert.ok(outcome.statut === 'ok');
  assert.equal(outcome.resume, '&'.repeat(120) + '…'); // 120 × 5 = 600 chars échappés
  assert.equal(escapeHtml(outcome.resume).length, 601); // plafond + marqueur, comme pour 'r'
  assert.equal(outcome.picks[0]?.raison, '&'.repeat(30) + '…'); // 30 × 5 = 150 chars échappés
  assert.equal(escapeHtml(outcome.picks[0]?.raison ?? '').length, 151);
});

test('les URLs en clair du modèle sont défangées dans résumé et raisons', async () => {
  // Telegram auto-linke toute URL en clair : sans défang, une injection de
  // prompt placerait un lien de phishing cliquable dans le récap.
  const mock = makeMock([
    reponseStructuree({
      resume: 'Va voir HTTPS://evil.example et http://phish.example pour la suite.',
      topPicks: [{ index: 1, raison: 'détails sur https://evil.example/payload' }],
    }),
  ]);
  const outcome = await enrichirDigest(config, diffAvecUniques(3), { fetchFn: mock.fetchFn });

  assert.ok(outcome.statut === 'ok');
  assert.ok(!/https?:\/\//i.test(outcome.resume));
  assert.equal(outcome.resume, 'Va voir hxxp://evil.example et hxxp://phish.example pour la suite.');
  assert.equal(outcome.picks[0]?.raison, 'détails sur hxxp://evil.example/payload');
});
