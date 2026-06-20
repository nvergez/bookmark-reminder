// Client X API v2 minimal : bookmarks + likes, une page chacun (PLAN.md §6 —
// rythme quotidien, pas de pagination). Pas de retry : le run quotidien suivant
// et l'alerte Telegram suffisent (PLAN.md §2).

import type { Config, FetchResult, Tweet } from './types.ts';

const API_BASE = 'https://api.x.com/2';

// ---------------------------------------------------------------------------
// Type guards maison (zéro dépendance) : on valide juste ce qu'on consomme.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface RawTweet {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  // Posts longs (> 280 chars) : `text` est tronqué par l'API, le texte complet
  // arrive dans `note_tweet.text` quand le champ est demandé via tweet.fields.
  note_tweet?: { text: string };
}

function isRawTweet(value: unknown): value is RawTweet {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || typeof value.text !== 'string') return false;
  if (value.author_id !== undefined && typeof value.author_id !== 'string') return false;
  if (value.created_at !== undefined && typeof value.created_at !== 'string') return false;
  if (value.note_tweet !== undefined) {
    // Absent = post court (forme normale) ; présent = objet avec text:string,
    // toute autre forme invalide le tweet entier.
    if (!isRecord(value.note_tweet) || typeof value.note_tweet.text !== 'string') return false;
  }
  return true;
}

interface RawUser {
  id: string;
  username: string;
  name: string;
}

function isRawUser(value: unknown): value is RawUser {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.username === 'string' &&
    typeof value.name === 'string'
  );
}

/**
 * L'API X v2 renvoie `text` (et `name`) déjà HTML-échappés pour & < >
 * (quirk historique : « R&D <3 » arrive comme « R&amp;D &lt;3 »). On décode
 * ici pour stocker le texte BRUT dans Tweet ; telegram.ts ré-échappe ensuite,
 * sinon Telegram afficherait les entités littéralement (« R&amp;D »).
 * `&amp;` est décodé en DERNIER : un tweet contenant littéralement « &lt; »
 * arrive comme « &amp;lt; » et doit redonner « &lt; », pas « < ».
 */
export function decodeApiEntities(s: string): string {
  return s.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

/**
 * Transforme un payload brut de l'API v2 (bookmarks ou liked_tweets) en
 * Tweet[]. Pur et sans réseau, pour être testable.
 *
 * - `data` absent = 0 résultat (forme normale de l'API) → [].
 * - Auteur introuvable dans includes.users → 'i'/'Inconnu' et l'URL
 *   universelle https://{domain}/i/status/{id}.
 * - L'ordre renvoyé par l'API est conservé (plus récents en premier).
 */
export function mapTweets(payload: unknown, tweetLinkDomain: string): Tweet[] {
  if (!isRecord(payload)) {
    throw new Error(`Réponse X inattendue : pas un objet JSON (reçu : ${typeof payload})`);
  }

  const data = payload.data;
  if (data === undefined) return []; // 0 résultat : l'API omet data
  if (!Array.isArray(data)) {
    throw new Error('Réponse X inattendue : le champ "data" n\'est pas un tableau');
  }

  const usersById = new Map<string, RawUser>();
  const includes = payload.includes;
  if (includes !== undefined) {
    if (!isRecord(includes)) {
      throw new Error('Réponse X inattendue : le champ "includes" n\'est pas un objet');
    }
    const users = includes.users;
    if (users !== undefined) {
      if (!Array.isArray(users)) {
        throw new Error('Réponse X inattendue : "includes.users" n\'est pas un tableau');
      }
      for (const user of users) {
        if (!isRawUser(user)) {
          throw new Error('Réponse X inattendue : entrée invalide dans "includes.users"');
        }
        usersById.set(user.id, user);
      }
    }
  }

  return data.map((raw, index) => {
    if (!isRawTweet(raw)) {
      throw new Error(`Réponse X inattendue : tweet invalide à l'index ${index} de "data"`);
    }
    const author = raw.author_id !== undefined ? usersById.get(raw.author_id) : undefined;
    const authorUsername = author?.username ?? 'i';
    return {
      id: raw.id,
      // Posts longs : note_tweet.text porte le texte complet, text n'en est
      // que le début tronqué (~280 chars).
      text: decodeApiEntities(raw.note_tweet?.text ?? raw.text),
      authorUsername,
      authorName: author !== undefined ? decodeApiEntities(author.name) : 'Inconnu',
      createdAt: raw.created_at ?? '',
      // /i/status/{id} : forme universelle quand l'auteur est inconnu
      url: `https://${tweetLinkDomain}/${authorUsername}/status/${raw.id}`,
    };
  });
}

async function fetchTimeline(
  endpoint: 'bookmarks' | 'liked_tweets',
  accessToken: string,
  userId: string,
  config: Config,
): Promise<Tweet[]> {
  const url = new URL(`${API_BASE}/users/${userId}/${endpoint}`);
  url.searchParams.set('max_results', String(config.maxResults));
  url.searchParams.set('tweet.fields', 'created_at,author_id,note_tweet');
  url.searchParams.set('expansions', 'author_id');
  url.searchParams.set('user.fields', 'username,name');

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const body = (await response.text().catch(() => '')).slice(0, 300);
    let hint = '';
    if (response.status === 401) {
      hint = ` — token invalide ou expiré, ${config.reauthHint}`;
    } else if (response.status === 429) {
      hint = ' — rate limit X atteint, réessayer plus tard';
    }
    throw new Error(
      `Échec de l'appel X GET /2/users/:id/${endpoint} (HTTP ${response.status})${hint}. Corps : ${body}`,
    );
  }

  const payload: unknown = await response.json();
  return mapTweets(payload, config.tweetLinkDomain);
}

/** Récupère une page de bookmarks et une page de likes (en parallèle). */
export async function fetchBookmarksAndLikes(
  accessToken: string,
  userId: string,
  config: Config,
): Promise<FetchResult> {
  const [bookmarks, likes] = await Promise.all([
    fetchTimeline('bookmarks', accessToken, userId, config),
    fetchTimeline('liked_tweets', accessToken, userId, config),
  ]);
  return { bookmarks, likes };
}
