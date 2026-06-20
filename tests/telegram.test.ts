// Tests purs du sender Telegram : aucun réseau, fetch et sleep injectés.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReponse } from '../src/ai.ts';
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
  reauthHint: 'relance `npm run auth`',
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

/** Mock fetch/sleep : enregistre les payloads, sert une file de réponses. */
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

test('escapeHtml échappe & < > et rien d’autre', () => {
  assert.equal(escapeHtml('a & b <c> "d"'), 'a &amp; b &lt;c&gt; "d"');
  assert.equal(escapeHtml('déjà &amp;'), 'déjà &amp;amp;'); // pas de double interprétation
  assert.equal(escapeHtml(''), '');
});

// --- chunkMessage -------------------------------------------------------

test('chunkMessage laisse intact un texte plus court que max', () => {
  assert.deepEqual(chunkMessage('court', 100), ['court']);
});

test('chunkMessage découpe de préférence sur un saut de ligne', () => {
  const s = 'ligne-1\nligne-2\nligne-3';
  const chunks = chunkMessage(s, 16);
  assert.deepEqual(chunks, ['ligne-1\nligne-2', 'ligne-3']);
});

test('chunkMessage découpe quand même un texte sans saut de ligne', () => {
  const s = 'a'.repeat(25);
  const chunks = chunkMessage(s, 10);
  assert.deepEqual(chunks, ['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
  assert.equal(chunks.join(''), s);
});

test('chunkMessage ne produit jamais de chunk vide', () => {
  const chunks = chunkMessage('a\nb\n\n\nc', 1);
  assert.deepEqual(chunks, ['a', 'b', 'c']);
  for (const chunk of chunks) assert.ok(chunk.length > 0);
});

test('chunkMessage ne coupe pas au milieu d’une entité HTML', () => {
  const s = 'aaaaaaaa&amp;bbbb'; // coupe dure à 10 tomberait dans &amp;
  const chunks = chunkMessage(s, 10);
  assert.deepEqual(chunks, ['aaaaaaaa', '&amp;bbbb']);
});

// --- sendDigest : digest normal ------------------------------------------

test('sendDigest envoie un récap notifiant puis un item silencieux par tweet', async () => {
  const mock = makeMock();
  const d = diff({
    newBookmarks: [tweet('1', 'premier bookmark'), tweet('2', 'second bookmark')],
    newLikes: [tweet('3', 'un like')],
  });
  await sendDigest(config, d, { statut: 'saute' }, { fetchFn: mock.fetchFn, sleepFn: mock.sleepFn });

  assert.equal(mock.calls.length, 4);
  const recap = mock.calls[0];
  assert.ok(recap);
  assert.ok(recap.url.includes('/botTEST_TOKEN/sendMessage'));
  assert.equal(recap.payload.chat_id, '4242');
  assert.equal(recap.payload.parse_mode, 'HTML');
  assert.equal(recap.payload.disable_notification, false);
  assert.deepEqual(recap.payload.link_preview_options, { is_disabled: true });
  assert.ok(recap.payload.text.includes('2 nouveaux bookmarks 🔖'));
  assert.ok(recap.payload.text.includes('1 nouveau like ❤️'));

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

  // throttle entre chaque message (pas avant le premier)
  assert.deepEqual(mock.sleeps, [1100, 1100, 1100]);
});

// --- sendDigest : premier run --------------------------------------------

test('sendDigest premier run : un seul message silencieux de référence', async () => {
  const mock = makeMock();
  // Forme réelle produite par computeDiff(null, …) : listes de nouveautés
  // VIDES, seuls les compteurs portent ce qui a été enregistré.
  const d = diff({
    isFirstRun: true,
    trackedCounts: { bookmarks: 2, likes: 1 },
  });
  await sendDigest(config, d, { statut: 'saute' }, { fetchFn: mock.fetchFn, sleepFn: mock.sleepFn });

  assert.equal(mock.calls.length, 1);
  const call = mock.calls[0];
  assert.ok(call);
  assert.equal(call.payload.disable_notification, true);
  assert.ok(call.payload.text.includes('2 bookmarks'));
  assert.ok(call.payload.text.includes('1 like'));
  assert.deepEqual(call.payload.link_preview_options, { is_disabled: true });
});

// --- sendDigest : rien de nouveau -----------------------------------------

test('sendDigest sans nouveautés : un seul « Rien de nouveau ✨ » silencieux', async () => {
  const mock = makeMock();
  await sendDigest(config, diff({}), { statut: 'saute' }, { fetchFn: mock.fetchFn, sleepFn: mock.sleepFn });

  assert.equal(mock.calls.length, 1);
  const call = mock.calls[0];
  assert.ok(call);
  assert.equal(call.payload.text, 'Rien de nouveau ✨');
  assert.equal(call.payload.disable_notification, true);
  assert.deepEqual(call.payload.link_preview_options, { is_disabled: true });
});

// --- sendDigest : récap enrichi par l'IA -----------------------------------

const LIGNE_INDISPONIBLE = '<i>🤖 résumé IA indisponible ce matin</i>';

test('récap enrichi à taille maximale : un seul chunk, silent: false exactement une fois', async () => {
  const mock = makeMock();
  const d = diff({
    newBookmarks: [tweet('1', 'premier bookmark'), tweet('2', 'second bookmark')],
    newLikes: [tweet('3', 'un like')],
  });
  // Pire cas RÉEL en sortie de parseReponse (et non un outcome fabriqué) :
  // résumé et raisons saturés de '&', qui quintuple au rendu ('&amp;'). Des
  // plafonds mesurés sur le texte brut donneraient ici un récap échappé
  // > 4096 chars → découpé en DEUX messages notifiants.
  const corpsModele = JSON.stringify({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          resume: '&'.repeat(1000),
          topPicks: [
            { index: 1, raison: '&'.repeat(400) },
            { index: 2, raison: '&'.repeat(400) },
            { index: 3, raison: '&'.repeat(400) },
          ],
        }),
      },
    ],
    stop_reason: 'end_turn',
  });
  const aiOutcome: AiOutcome = parseReponse(
    200,
    corpsModele,
    [...d.newBookmarks, ...d.newLikes].map((t) => ({ tweet: t, bookmarkEtLike: false })),
  );
  assert.ok(aiOutcome.statut === 'ok');
  assert.equal(aiOutcome.picks.length, 3);
  await sendDigest(config, d, aiOutcome, { fetchFn: mock.fetchFn, sleepFn: mock.sleepFn });

  // 1 récap + 3 items : le récap n'a PAS été découpé par chunkMessage
  assert.equal(mock.calls.length, 4);
  const recap = mock.calls[0];
  assert.ok(recap);
  assert.equal(chunkMessage(recap.payload.text).length, 1);
  assert.ok(recap.payload.text.length <= 4096); // texte RENDU (échappé) sous la limite Telegram
  // Compteurs D'ABORD : l'aperçu de notification reste utile
  assert.ok(recap.payload.text.startsWith('☀️ Ce matin : 2 nouveaux bookmarks 🔖, 1 nouveau like ❤️'));
  assert.ok(recap.payload.text.includes('\n\n🧠 ' + '&amp;'.repeat(120) + '…'));
  assert.ok(recap.payload.text.includes('\n\n⭐ À lire en premier :'));
  assert.ok(recap.payload.text.includes('\n• <b>@alice</b> — ' + '&amp;'.repeat(30) + '…\nhttps://x.com/alice/status/1'));
  assert.ok(recap.payload.text.includes('\nhttps://x.com/alice/status/3'));
  assert.ok(!recap.payload.text.includes(LIGNE_INDISPONIBLE)); // jamais sur 'ok'
  // link_preview_options reste désactivé sur le récap
  assert.deepEqual(recap.payload.link_preview_options, { is_disabled: true });
  // silent: false exactement une fois (le récap) ; les items restent silencieux
  const notifiants = mock.calls.filter((call) => !call.payload.disable_notification);
  assert.equal(notifiants.length, 1);
  assert.equal(notifiants[0], recap);
});

test('ligne d’indisponibilité rendue UNIQUEMENT quand le statut est echec', async () => {
  const d = diff({ newBookmarks: [tweet('1', 'premier bookmark')] });

  const surEchec = makeMock();
  await sendDigest(config, d, { statut: 'echec', raison: 'HTTP 401 — clé révoquée' }, {
    fetchFn: surEchec.fetchFn,
    sleepFn: surEchec.sleepFn,
  });
  const recapEchec = surEchec.calls[0]?.payload.text ?? '';
  assert.ok(recapEchec.startsWith('☀️ Ce matin : ')); // compteurs toujours d'abord
  assert.ok(recapEchec.endsWith(`\n\n${LIGNE_INDISPONIBLE}`));
  assert.ok(!recapEchec.includes('HTTP 401')); // la raison reste en console, pas dans Telegram

  const surSaute = makeMock();
  await sendDigest(config, d, { statut: 'saute' }, { fetchFn: surSaute.fetchFn, sleepFn: surSaute.sleepFn });
  assert.ok(!(surSaute.calls[0]?.payload.text ?? '').includes(LIGNE_INDISPONIBLE));

  const surOk = makeMock();
  await sendDigest(config, d, { statut: 'ok', resume: 'résumé du jour', picks: [] }, {
    fetchFn: surOk.fetchFn,
    sleepFn: surOk.sleepFn,
  });
  assert.ok(!(surOk.calls[0]?.payload.text ?? '').includes(LIGNE_INDISPONIBLE));
});

test('récap enrichi : auteur, raison et résumé passent par escapeHtml', async () => {
  const mock = makeMock();
  const piege: Tweet = { ...tweet('1', 'premier bookmark'), authorUsername: 'eve<&>' };
  const aiOutcome: AiOutcome = {
    statut: 'ok',
    resume: 'résumé <fin> & co',
    picks: [{ tweet: piege, raison: 'à <lire> & relire' }],
  };
  await sendDigest(config, diff({ newBookmarks: [piege] }), aiOutcome, {
    fetchFn: mock.fetchFn,
    sleepFn: mock.sleepFn,
  });

  const recap = mock.calls[0]?.payload.text ?? '';
  assert.ok(recap.includes('\n\n🧠 résumé &lt;fin&gt; &amp; co'));
  // Le <b> s'ouvre et se ferme sur la même ligne, autour de l'auteur échappé
  assert.ok(recap.includes('\n• <b>@eve&lt;&amp;&gt;</b> — à &lt;lire&gt; &amp; relire\nhttps://x.com/alice/status/1'));
  assert.ok(!recap.includes('@eve<&>')); // jamais de HTML brut issu des données
});

test('digest octet-identique à aujourd’hui quand le statut est saute', async () => {
  const d = diff({
    newBookmarks: [tweet('1', 'premier bookmark')],
    newLikes: [tweet('2', 'un like')],
  });
  const surSaute = makeMock();
  await sendDigest(config, d, { statut: 'saute' }, { fetchFn: surSaute.fetchFn, sleepFn: surSaute.sleepFn });
  // Récap strictement identique à la chaîne actuelle : rien d'ajouté
  assert.equal(surSaute.calls[0]?.payload.text, '☀️ Ce matin : 1 nouveau bookmark 🔖, 1 nouveau like ❤️');

  // L'appel à deux arguments (compat) rend exactement les mêmes payloads
  const parDefaut = makeMock();
  await sendDigest(config, d, undefined, { fetchFn: parDefaut.fetchFn, sleepFn: parDefaut.sleepFn });
  assert.deepEqual(
    parDefaut.calls.map((call) => call.payload),
    surSaute.calls.map((call) => call.payload),
  );
});

// --- 429 → retry ----------------------------------------------------------

test('HTTP 429 : attend parameters.retry_after puis réessaie une fois', async () => {
  const tooMany = new Response(
    JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 3 } }),
    { status: 429 },
  );
  const mock = makeMock([tooMany, telegramOk()]);
  await sendDigest(config, diff({}), { statut: 'saute' }, { fetchFn: mock.fetchFn, sleepFn: mock.sleepFn });

  assert.equal(mock.calls.length, 2);
  const firstTry = mock.calls[0];
  const retry = mock.calls[1];
  assert.ok(firstTry);
  assert.ok(retry);
  assert.equal(firstTry.payload.text, retry.payload.text); // même message rejoué
  assert.deepEqual(mock.sleeps, [3000]);
});

test('non-2xx hors 429 : throw avec la description du body', async () => {
  const forbidden = new Response(
    JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked' }),
    { status: 403 },
  );
  const mock = makeMock([forbidden]);
  await assert.rejects(
    sendDigest(config, diff({}), { statut: 'saute' }, { fetchFn: mock.fetchFn, sleepFn: mock.sleepFn }),
    /403.*bot was blocked/s,
  );
});

// --- sendErrorAlert --------------------------------------------------------

test('sendErrorAlert envoie une alerte notifiante avec le message échappé', async () => {
  const mock = makeMock();
  await sendErrorAlert(config, new Error('refresh <token> & co'), {
    fetchFn: mock.fetchFn,
    sleepFn: mock.sleepFn,
  });

  assert.equal(mock.calls.length, 1);
  const call = mock.calls[0];
  assert.ok(call);
  assert.equal(call.payload.disable_notification, false);
  assert.ok(call.payload.text.startsWith('⚠️ Le bot bookmark-reminder a échoué : '));
  assert.ok(call.payload.text.includes('refresh &lt;token&gt; &amp; co'));
});

test('sendErrorAlert ne throw jamais, même si l’envoi échoue', async () => {
  const fetchFn: typeof fetch = async () => {
    throw new Error('réseau coupé');
  };
  const sleepFn = async (): Promise<void> => {};
  await sendErrorAlert(config, new Error('boom'), { fetchFn, sleepFn }); // ne doit pas rejeter
});
