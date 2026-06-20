// Shared contracts between the bot's modules (see PLAN.md §2).

export interface Config {
  xClientId: string;
  /** null for a public client (PKCE only) */
  xClientSecret: string | null;
  telegramBotToken: string;
  telegramChatId: string;
  /** posts requested per endpoint per run (5-100, default 25 —
   * liked_tweets rejects max_results < 5, hence the shared lower bound) */
  maxResults: number;
  /** domain for the links in the digest (default x.com, fallback fixupx.com) */
  tweetLinkDomain: string;
  /** re-authentication directive injected into error messages,
   * tailored to the environment: "re-run `npm run auth`" locally,
   * /auth?k=… link on the Worker (SPIKE-HOSTING.md §3.2) */
  reauthHint: string;
  /** Anthropic API key, OPTIONAL: null = AI digest summary disabled,
   * the bot behaves exactly as before (PLAN-IA-DIGEST.md §3) */
  anthropicApiKey: string | null;
  /** Claude model for the summary (default claude-opus-4-8, $5/$25 per MTok),
   * never silently substituted — sonnet/haiku cheaper via ANTHROPIC_MODEL */
  anthropicModel: string;
}

export interface Tweet {
  id: string;
  text: string;
  /** without the @ */
  authorUsername: string;
  authorName: string;
  /** the tweet's creation date (ISO) — NOT the date the bookmark/like was added,
   * which X never exposes */
  createdAt: string;
  /** https://{tweetLinkDomain}/{authorUsername}/status/{id} */
  url: string;
}

export interface FetchResult {
  bookmarks: Tweet[];
  likes: Tweet[];
}

/** Contents of tokens.json. The X refresh token is SINGLE-USE:
 * any rotation must be atomically persisted before any other use. */
export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** epoch ms when the access token expires */
  expiresAt: number;
  /** numeric id of the X account, resolved once at auth time */
  userId: string;
  username?: string;
}

/** Contents of state.json: already-seen IDs, most recent first. */
export interface BotState {
  bookmarkIds: string[];
  likeIds: string[];
  lastRunAt: string | null;
}

export interface DigestDiff {
  newBookmarks: Tweet[];
  newLikes: Tweet[];
  /** first run: we establish the baseline, no digest of items */
  isFirstRun: boolean;
  /** totals actually seen this run (newBookmarks/newLikes are empty on the first
   * run: only these counters allow an accurate "baseline established" summary) */
  trackedCounts: { bookmarks: number; likes: number };
}
