// Cœur du run quotidien (PLAN.md §2), partagé local/Worker : auth → fetch →
// diff → enrichissement IA → envoi → persistance. Aucun import node:*, aucune
// sortie console — l'appelant (digest.ts ou le Durable Object) logge le résumé
// retourné, qui porte aussi le statut IA.

import { enrichirDigest, type AiDeps, type AiOutcome } from './ai.ts';
import { computeDiff } from './state.ts';
import type { Storage } from './storage.ts';
import { sendDigest, type TelegramDeps } from './telegram.ts';
import { getValidAccessToken } from './tokens.ts';
import type { Config } from './types.ts';
import { fetchBookmarksAndLikes } from './x.ts';

export async function runDigest(
  config: Config,
  storage: Storage,
  telegramDeps?: TelegramDeps,
  aiDeps?: AiDeps,
): Promise<string> {
  const startedAt = Date.now();

  const { accessToken, userId } = await getValidAccessToken(config, storage);
  const fetched = await fetchBookmarksAndLikes(accessToken, userId, config);

  const previousState = await storage.getState();
  const { diff, nextState } = computeDiff(previousState, fetched, new Date().toISOString());

  // Enrichissement IA fail-open (PLAN-IA-DIGEST.md §3) : enrichirDigest gère
  // « sauté » en interne et capture ses propres erreurs — ce try/catch est le
  // dernier filet contre une exception imprévue. Un échec Claude ne supprime
  // jamais le digest ni ne bloque putState.
  let aiOutcome: AiOutcome;
  try {
    aiOutcome = await enrichirDigest(config, diff, aiDeps);
  } catch (err) {
    aiOutcome = { statut: 'echec', raison: err instanceof Error ? err.message : String(err) };
  }

  await sendDigest(config, diff, aiOutcome, telegramDeps);

  // Persisté APRÈS l'envoi réussi : si Telegram échoue, on re-signalera
  // les mêmes items demain (un doublon vaut mieux qu'un trou).
  await storage.putState(nextState);

  const durationS = ((Date.now() - startedAt) / 1000).toFixed(1);
  const summary = diff.isFirstRun
    ? `premier run : référence établie (${diff.trackedCounts.bookmarks} bookmarks, ${diff.trackedCounts.likes} likes vus)`
    : `${diff.newBookmarks.length} nouveau(x) bookmark(s), ${diff.newLikes.length} nouveau(x) like(s)`;
  // Suffixe de statut IA : la console locale et `wrangler tail` portent la
  // cause d'un échec sans console.* ici. Rien quand « sauté » : les chaînes
  // actuelles restent octet-identiques.
  const statutIa =
    aiOutcome.statut === 'ok'
      ? ' — résumé IA : ok'
      : aiOutcome.statut === 'echec'
        ? ` — résumé IA : échec (${aiOutcome.raison})`
        : '';
  return `${summary} — ${durationS} s${statutIa}`;
}
