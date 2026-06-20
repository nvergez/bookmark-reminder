// Contrats partagés entre les modules du bot (voir PLAN.md §2).

export interface Config {
  xClientId: string;
  /** null pour un client public (PKCE seul) */
  xClientSecret: string | null;
  telegramBotToken: string;
  telegramChatId: string;
  /** posts demandés par endpoint et par run (5-100, défaut 25 —
   * liked_tweets refuse max_results < 5, d'où la borne basse commune) */
  maxResults: number;
  /** domaine des liens dans le digest (défaut x.com, fallback fixupx.com) */
  tweetLinkDomain: string;
  /** consigne de ré-authentification injectée dans les messages d'erreur,
   * adaptée à l'environnement : « relance `npm run auth` » en local,
   * lien /auth?k=… sur le Worker (SPIKE-HOSTING.md §3.2) */
  reauthHint: string;
  /** clé API Anthropic, OPTIONNELLE : null = résumé IA du digest désactivé,
   * le bot se comporte exactement comme avant (PLAN-IA-DIGEST.md §3) */
  anthropicApiKey: string | null;
  /** modèle Claude du résumé (défaut claude-opus-4-8, 5 $/25 $ par MTok),
   * jamais substitué en silence — sonnet/haiku moins chers via ANTHROPIC_MODEL */
  anthropicModel: string;
}

export interface Tweet {
  id: string;
  text: string;
  /** sans le @ */
  authorUsername: string;
  authorName: string;
  /** date de création du tweet (ISO) — PAS la date d'ajout du bookmark/like,
   * que X n'expose jamais */
  createdAt: string;
  /** https://{tweetLinkDomain}/{authorUsername}/status/{id} */
  url: string;
}

export interface FetchResult {
  bookmarks: Tweet[];
  likes: Tweet[];
}

/** Contenu de tokens.json. Le refresh token X est à USAGE UNIQUE :
 * toute rotation doit être persistée atomiquement avant tout autre usage. */
export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** epoch ms d'expiration de l'access token */
  expiresAt: number;
  /** id numérique du compte X, résolu une fois au moment de l'auth */
  userId: string;
  username?: string;
}

/** Contenu de state.json : IDs déjà vus, plus récents en premier. */
export interface BotState {
  bookmarkIds: string[];
  likeIds: string[];
  lastRunAt: string | null;
}

export interface DigestDiff {
  newBookmarks: Tweet[];
  newLikes: Tweet[];
  /** premier run : on établit la référence, pas de digest d'items */
  isFirstRun: boolean;
  /** totaux réellement vus ce run (newBookmarks/newLikes sont vides au premier
   * run : seuls ces compteurs permettent un récap « référence établie » exact) */
  trackedCounts: { bookmarks: number; likes: number };
}
