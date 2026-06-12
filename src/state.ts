// Diff d'IDs et validation du state — logique pure, aucun import node:* :
// la persistance vit derrière l'abstraction Storage (fsStorage.ts / Worker).

import type { BotState, DigestDiff, FetchResult, Tweet } from './types.ts';

/** Plafond d'IDs conservés par liste (PLAN.md E3). */
export const STATE_MAX_IDS = 2000;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Valide la forme d'un state persisté (fichier local ou Durable Object).
 * Forme invalide → throw : le digest doit ALERTER, pas repartir de zéro en
 * silence (un state perdu = re-digest de tout l'historique récent).
 * `source` contextualise le message (chemin du fichier, « Durable Object »…).
 */
export function validateStateShape(parsed: unknown, source: string): BotState {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`state invalide (objet attendu) : ${source}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (!isStringArray(obj.bookmarkIds) || !isStringArray(obj.likeIds)) {
    throw new Error(
      `state invalide (bookmarkIds/likeIds doivent être des tableaux de chaînes) : ${source}`,
    );
  }
  if (obj.lastRunAt !== null && typeof obj.lastRunAt !== 'string') {
    throw new Error(`state invalide (lastRunAt doit être une chaîne ou null) : ${source}`);
  }

  return {
    bookmarkIds: obj.bookmarkIds,
    likeIds: obj.likeIds,
    lastRunAt: obj.lastRunAt,
  };
}

/**
 * Diff d'une liste : nouveaux tweets (ordre API préservé, plus récents en
 * premier) + prochaine liste d'IDs. On garde les anciens IDs non re-vus car
 * un tweet peut sortir de la fenêtre max_results tout en restant bookmarké :
 * le re-voir plus tard ne doit PAS le re-signaler.
 */
function diffList(
  previousIds: string[],
  fetched: Tweet[],
): { newTweets: Tweet[]; nextIds: string[] } {
  const previousSet = new Set(previousIds);
  const newTweets = fetched.filter((tweet) => !previousSet.has(tweet.id));

  const nextIds: string[] = [];
  const seen = new Set<string>();
  for (const tweet of fetched) {
    if (!seen.has(tweet.id)) {
      seen.add(tweet.id);
      nextIds.push(tweet.id);
    }
  }
  for (const id of previousIds) {
    if (!seen.has(id)) {
      seen.add(id);
      nextIds.push(id);
    }
  }

  return { newTweets, nextIds: nextIds.slice(0, STATE_MAX_IDS) };
}

/**
 * PUR. previous === null → premier run : on établit la référence sans
 * signaler de nouveautés (PLAN.md §6). Bookmarks et likes sont diffés
 * indépendamment.
 */
export function computeDiff(
  previous: BotState | null,
  fetched: FetchResult,
  nowIso: string,
): { diff: DigestDiff; nextState: BotState } {
  const trackedCounts = { bookmarks: fetched.bookmarks.length, likes: fetched.likes.length };

  if (previous === null) {
    return {
      diff: { newBookmarks: [], newLikes: [], isFirstRun: true, trackedCounts },
      nextState: {
        bookmarkIds: diffList([], fetched.bookmarks).nextIds,
        likeIds: diffList([], fetched.likes).nextIds,
        lastRunAt: nowIso,
      },
    };
  }

  const bookmarks = diffList(previous.bookmarkIds, fetched.bookmarks);
  const likes = diffList(previous.likeIds, fetched.likes);

  return {
    diff: {
      newBookmarks: bookmarks.newTweets,
      newLikes: likes.newTweets,
      isFirstRun: false,
      trackedCounts,
    },
    nextState: {
      bookmarkIds: bookmarks.nextIds,
      likeIds: likes.nextIds,
      lastRunAt: nowIso,
    },
  };
}
