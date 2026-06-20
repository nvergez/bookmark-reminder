// Tests du cœur runDigest : storage en mémoire, fetch Telegram/Anthropic
// injectés (façon telegram.test.ts). Seul l'appel X passe par le fetch global
// (non injectable) : il est stubbé puis restauré autour de chaque scénario.

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
  reauthHint: 'relance `npm run auth`',
  anthropicApiKey: 'sk-ant-test',
  anthropicModel: 'claude-opus-4-8',
};

/** Storage en mémoire : tokens valides (aucun refresh réseau), state injecté. */
function makeStorage(initialState: BotState | null) {
  const tokens: Tokens = {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + 3_600_000, // loin dans le futur : pas de refresh
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

/** State « veille » vide : tout tweet renvoyé par X est une nouveauté. */
function stateVide(): BotState {
  return { bookmarkIds: [], likeIds: [], lastRunAt: '2026-06-12T07:00:00.000Z' };
}

/** Réponse X v2 (bookmarks ou liked_tweets) avec n tweets d'ids préfixés. */
function reponseX(prefixe: string, n: number): Response {
  const data = [];
  for (let i = 1; i <= n; i += 1) {
    data.push({
      id: `${prefixe}${i}`,
      text: `tweet ${prefixe}${i}`,
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

/** Stubbe le fetch global (appels X uniquement) le temps du scénario, puis le
 * restaure même en cas d'échec. bookmarks/likes : nombre de tweets servis. */
async function avecFetchX(
  compte: { bookmarks: number; likes: number },
  scenario: () => Promise<void>,
): Promise<void> {
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/bookmarks')) return reponseX('b', compte.bookmarks);
    if (url.includes('/liked_tweets')) return reponseX('l', compte.likes);
    throw new Error(`fetch global inattendu dans le test : ${url}`);
  }) as typeof fetch;
  try {
    await scenario();
  } finally {
    globalThis.fetch = fetchOriginal;
  }
}

/** Mock du fetch Telegram : enregistre les textes envoyés, répond toujours ok. */
function makeTelegramMock() {
  const textes: string[] = [];
  const fetchFn: typeof fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body)) as { text: string };
    textes.push(payload.text);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  };
  const sleepFn = async (): Promise<void> => {};
  return { textes, fetchFn, sleepFn };
}

/** Mock du fetch Anthropic : sert une file de réponses, compte les appels. */
function makeAiMock(queue: Response[]) {
  const calls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    calls.push(String(input));
    const next = queue.shift();
    if (next === undefined) throw new Error('mock fetch IA : aucune réponse en file');
    return next;
  };
  return { calls, fetchFn };
}

/** Réponse Anthropic dont le bloc texte porte la sortie structurée donnée. */
function reponseStructuree(sortie: unknown): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify(sortie) }],
      stop_reason: 'end_turn',
    }),
    { status: 200 },
  );
}

// --- statut « sauté » -------------------------------------------------------

test('runDigest sans clé IA : résumé octet-identique à aujourd’hui, aucun appel Anthropic', async () => {
  await avecFetchX({ bookmarks: 3, likes: 1 }, async () => {
    const { storage, putStates } = makeStorage(stateVide());
    const telegram = makeTelegramMock();
    const ai = makeAiMock([]);

    const summary = await runDigest(
      { ...config, anthropicApiKey: null },
      storage,
      { fetchFn: telegram.fetchFn, sleepFn: telegram.sleepFn },
      { fetchFn: ai.fetchFn },
    );

    // Chaîne actuelle inchangée : aucun suffixe IA quand le statut est « sauté »
    assert.match(summary, /^3 nouveau\(x\) bookmark\(s\), 1 nouveau\(x\) like\(s\) — \d+\.\d s$/);
    assert.ok(!summary.includes('résumé IA'));
    assert.equal(ai.calls.length, 0); // feature off : jamais d'appel réseau
    assert.equal(putStates.length, 1);
  });
});

// --- statut « echec » -------------------------------------------------------

test('runDigest IA en échec : suffixe « — résumé IA : échec (…) », digest envoyé et state persisté', async () => {
  await avecFetchX({ bookmarks: 3, likes: 0 }, async () => {
    const { storage, putStates } = makeStorage(stateVide());
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

    // Le résumé porte la cause pour la console locale et wrangler tail
    assert.match(summary, /^3 nouveau\(x\) bookmark\(s\), 0 nouveau\(x\) like\(s\) — \d+\.\d s — résumé IA : échec \(HTTP 401/);
    // L'échec Claude ne supprime jamais le digest ni ne bloque putState
    assert.equal(telegram.textes.length, 4); // récap + 3 items
    assert.ok(telegram.textes[0]?.includes('<i>🤖 résumé IA indisponible ce matin</i>'));
    assert.equal(putStates.length, 1);
  });
});

// --- statut « ok » ----------------------------------------------------------

test('runDigest IA ok : suffixe « — résumé IA : ok » et récap enrichi', async () => {
  await avecFetchX({ bookmarks: 3, likes: 0 }, async () => {
    const { storage, putStates } = makeStorage(stateVide());
    const telegram = makeTelegramMock();
    const ai = makeAiMock([
      reponseStructuree({
        resume: 'Thème du jour : agents IA.',
        topPicks: [{ index: 1, raison: 'le plus dense' }],
      }),
    ]);

    const summary = await runDigest(
      config,
      storage,
      { fetchFn: telegram.fetchFn, sleepFn: telegram.sleepFn },
      { fetchFn: ai.fetchFn },
    );

    assert.match(summary, /^3 nouveau\(x\) bookmark\(s\), 0 nouveau\(x\) like\(s\) — \d+\.\d s — résumé IA : ok$/);
    assert.equal(ai.calls.length, 1); // un seul essai, jamais de retry
    const recap = telegram.textes[0] ?? '';
    assert.ok(recap.includes('🧠 Thème du jour : agents IA.'));
    assert.ok(recap.includes('⭐ À lire en premier :'));
    // URL résolue côté client depuis le diff, jamais issue du modèle
    assert.ok(recap.includes('• <b>@alice</b> — le plus dense\nhttps://x.com/alice/status/b1'));
    assert.equal(putStates.length, 1);
  });
});
