// Cloudflare Worker (PLAN.md E6, SPIKE-HOSTING.md §3-§4): daily cron +
// hosted OAuth auth routes. The ENTIRE run executes inside the Durable
// Object: its output gates hold back any outgoing network message until
// the refresh token rotation (storage.put) is flushed to disk —
// the cloud equivalent of the local atomic write (fsUtil.ts).

import { DurableObject } from 'cloudflare:workers';
import { parseMaxResults } from '../src/maxResults.ts';
import {
  buildAuthorizeUrl,
  codeChallengeS256,
  exchangeCode,
  generateCodeVerifier,
  randomStateParam,
} from '../src/oauth.ts';
import { isLocalTime } from '../src/schedule.ts';
import { validateStateShape } from '../src/state.ts';
import type { Storage } from '../src/storage.ts';
import { escapeHtml, sendErrorAlert } from '../src/telegram.ts';
import { isValidTokens } from '../src/tokens.ts';
import { runDigest } from '../src/run.ts';
import type { BotState, Config, Tokens } from '../src/types.ts';

export interface Env {
  BOT_DO: DurableObjectNamespace<BotDO>;
  // Secrets (wrangler secret put …)
  X_CLIENT_ID: string;
  X_CLIENT_SECRET?: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  /** Access secret for the /auth, /run and /admin/* routes
   * (?k=… or Authorization: Bearer header). */
  AUTH_URL_KEY: string;
  /** OPTIONAL: enables the AI digest summary (PLAN-IA-DIGEST.md §3) —
   * absent = bot unchanged. `wrangler secret put ANTHROPIC_API_KEY` */
  ANTHROPIC_API_KEY?: string;
  // Vars (wrangler.jsonc)
  /** Public URL of the Worker, for the re-auth link in alerts. */
  BASE_URL?: string;
  /** Europe/Paris local time of the digest (default 08:30) — guard for the double-cron. */
  DIGEST_PARIS_TIME?: string;
  MAX_RESULTS?: string;
  TWEET_LINK_DOMAIN?: string;
  /** Claude model for the AI summary (default claude-opus-4-8). */
  ANTHROPIC_MODEL?: string;
  /** "on" during the local→cloud switchover only (token import/export);
   * switch back to "off" + redeploy once the switchover is done. */
  ADMIN_API?: string;
}

const PARIS_TZ = 'Europe/Paris';
const PENDING_AUTH_TTL_MS = 10 * 60_000;

interface PendingAuth {
  verifier: string;
  state: string;
  redirectUri: string;
  createdAt: number;
}

function buildConfig(env: Env): Config {
  const missing = (
    ['X_CLIENT_ID', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'AUTH_URL_KEY'] as const
  ).filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing secrets on the Worker: ${missing.join(', ')} — \`wrangler secret put <NAME>\``,
    );
  }
  const reauthHint = env.BASE_URL
    ? `re-authorize here: ${env.BASE_URL}/auth?k=${env.AUTH_URL_KEY}`
    : 'open https://<worker>/auth?k=<AUTH_URL_KEY> to re-authorize';
  return {
    xClientId: env.X_CLIENT_ID,
    xClientSecret: env.X_CLIENT_SECRET || null,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramChatId: env.TELEGRAM_CHAT_ID,
    maxResults: parseMaxResults(env.MAX_RESULTS),
    tweetLinkDomain: env.TWEET_LINK_DOMAIN || 'x.com',
    reauthHint,
    // OPTIONAL (outside the required check): absent = AI summary off, bot unchanged.
    anthropicApiKey: env.ANTHROPIC_API_KEY || null,
    anthropicModel: env.ANTHROPIC_MODEL || 'claude-opus-4-8',
  };
}

/** Constant-time comparison of the URL secret (no node:crypto here). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class BotDO extends DurableObject<Env> {
  // Storage adapter on top of the DO's SQLite storage. The values are
  // structured objects (no JSON.stringify); shape validation stays here
  // to catch corruption or a failed import.
  private readonly botStorage: Storage = {
    getTokens: async (): Promise<Tokens | null> => {
      const value = await this.ctx.storage.get('tokens');
      if (value === undefined) return null;
      if (!isValidTokens(value)) {
        throw new Error('Invalid Durable Object tokens — redo an import or an auth');
      }
      return value;
    },
    putTokens: async (tokens: Tokens): Promise<void> => {
      await this.ctx.storage.put('tokens', tokens);
    },
    getState: async (): Promise<BotState | null> => {
      const value = await this.ctx.storage.get('state');
      if (value === undefined) return null;
      return validateStateShape(value, 'Durable Object');
    },
    putState: async (state: BotState): Promise<void> => {
      await this.ctx.storage.put('state', state);
    },
  };

  /** In-flight run promise. The DO's input gates do not cover
   * `await fetch()`: without this guard, a /run concurrent with the cron
   * could consume the same (single-use) X refresh token twice. */
  private running: Promise<{ ok: boolean; detail: string }> | null = null;

  /** Full daily run. Never throws: the failure goes out as a Telegram alert
   * (best-effort) and surfaces as { ok: false } for the logs. */
  async runDigestSafe(): Promise<{ ok: boolean; detail: string }> {
    this.running ??= this.runDigestOnce().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runDigestOnce(): Promise<{ ok: boolean; detail: string }> {
    let config: Config;
    try {
      config = buildConfig(this.env);
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
    try {
      const summary = await runDigest(config, this.botStorage);
      return { ok: true, detail: summary };
    } catch (err) {
      await sendErrorAlert(config, err);
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Starts a PKCE flow: persists verifier/state, returns the X URL. */
  async beginAuth(redirectUri: string): Promise<string> {
    const config = buildConfig(this.env);
    const pending: PendingAuth = {
      verifier: generateCodeVerifier(),
      state: randomStateParam(),
      redirectUri,
      createdAt: Date.now(),
    };
    await this.ctx.storage.put('pendingAuth', pending);
    const challenge = await codeChallengeS256(pending.verifier);
    return buildAuthorizeUrl(config.xClientId, pending.state, challenge, redirectUri);
  }

  /** Completes the flow: verifies the state (one-shot), exchanges the code, and
   * rejects an X account different from the one already known (SPIKE §3.3). */
  async completeAuth(code: string, state: string): Promise<string> {
    const config = buildConfig(this.env);
    const pending = (await this.ctx.storage.get('pendingAuth')) as PendingAuth | undefined;
    if (!pending || Date.now() - pending.createdAt > PENDING_AUTH_TTL_MS) {
      await this.ctx.storage.delete('pendingAuth');
      throw new Error('No auth flow pending (or expired) — go through /auth again');
    }
    if (!safeEqual(state, pending.state)) {
      // pendingAuth NOT consumed: /callback is public, a forged state must
      // not be able to cancel the legitimate flow in progress.
      throw new Error('Invalid state parameter (possible CSRF) — flow aborted');
    }
    // One-shot: consumed as soon as the state matches (a state cannot be replayed).
    await this.ctx.storage.delete('pendingAuth');

    const tokens = await exchangeCode(config, code, pending.verifier, pending.redirectUri);
    const existing = await this.botStorage.getTokens().catch(() => null);
    if (existing && existing.userId !== tokens.userId) {
      throw new Error(
        `Unexpected X account (@${tokens.username ?? tokens.userId}) — only the tokens of the original account are accepted`,
      );
    }
    await this.botStorage.putTokens(tokens);
    return tokens.username ?? tokens.userId;
  }

  /** Seed for the local→cloud switchover (SPIKE §3.4): tokens AND state. */
  async importData(payload: { tokens?: unknown; state?: unknown }): Promise<string> {
    if (!isValidTokens(payload.tokens)) {
      throw new Error('Import rejected: "tokens" field absent or of invalid shape');
    }
    if (payload.state === undefined) {
      throw new Error(
        'Import rejected: "state" field missing — without it the first cloud run silently re-establishes the baseline (SPIKE-HOSTING.md §3.4)',
      );
    }
    const state = validateStateShape(payload.state, 'import');
    await this.ctx.storage.put('tokens', payload.tokens);
    await this.ctx.storage.put('state', state);
    return `import OK: tokens (@${payload.tokens.username ?? payload.tokens.userId}) + state (${state.bookmarkIds.length} bookmarks, ${state.likeIds.length} likes tracked)`;
  }

  /** Symmetric export, for the cloud→local rollback (SPIKE §3.4 step 5). */
  async exportData(): Promise<{ tokens: Tokens | null; state: BotState | null }> {
    return {
      tokens: ((await this.ctx.storage.get('tokens')) as Tokens | undefined) ?? null,
      state: ((await this.ctx.storage.get('state')) as BotState | undefined) ?? null,
    };
  }
}

function htmlPage(title: string, detail: string): Response {
  // title/detail can carry external data (`error` parameter from the OAuth
  // callback, exception messages): everything is escaped, with CSP as
  // defense in depth.
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family: system-ui; max-width: 32rem; margin: 4rem auto;">
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body></html>`;
  return new Response(body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}

function notFound(): Response {
  return new Response('Not found', { status: 404 });
}

/** Key accepted in the Authorization header (preferred: no secret in the
 * URLs, which the invocation logs capture) or in ?k= (required for the
 * /auth link to be clickable from a Telegram alert). */
function hasValidKey(request: Request, url: URL, env: Env): boolean {
  const header = request.headers.get('Authorization') ?? '';
  const provided = header.startsWith('Bearer ')
    ? header.slice('Bearer '.length)
    : url.searchParams.get('k') ?? '';
  return safeEqual(provided, env.AUTH_URL_KEY ?? '');
}

/** Auth errors embed the full re-auth link (?k=<secret>) intended for the
 * Telegram alert; the Workers logs (persisted when observability is
 * enabled) must never contain the key. */
function redactKey(detail: string, env: Env): string {
  return env.AUTH_URL_KEY ? detail.replaceAll(env.AUTH_URL_KEY, '<AUTH_URL_KEY>') : detail;
}

function botStub(env: Env): DurableObjectStub<BotDO> {
  // A singleton: all requests and all crons talk to the same DO.
  return env.BOT_DO.get(env.BOT_DO.idFromName('bot'));
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const target = env.DIGEST_PARIS_TIME || '08:30';
    if (!isLocalTime(controller.scheduledTime, target, PARIS_TZ)) {
      // The other branch of the UTC double-cron: to be ignored (SPIKE §4).
      console.log(`Cron ${controller.cron} ignored (not ${target} ${PARIS_TZ})`);
      return;
    }
    const result = await botStub(env).runDigestSafe();
    if (result.ok) {
      console.log(`Digest OK — ${result.detail}`);
    } else {
      // The Telegram alert has already gone out (best-effort); the log stays for wrangler tail.
      console.error(`Digest run failed: ${redactKey(result.detail, env)}`);
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/auth': {
        if (request.method !== 'GET' || !hasValidKey(request, url, env)) return notFound();
        const redirectUri = `${url.origin}/callback`;
        const authorizeUrl = await botStub(env).beginAuth(redirectUri);
        return Response.redirect(authorizeUrl, 302);
      }

      case '/callback': {
        // No ?k here (X redirects without it): the protection is the one-shot state.
        if (request.method !== 'GET') return notFound();
        const oauthError = url.searchParams.get('error');
        if (oauthError) {
          return htmlPage('Authorization denied', `X returned: ${oauthError}`);
        }
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (!code || !state) {
          return htmlPage('Invalid callback', 'Missing code/state parameters.');
        }
        try {
          const username = await botStub(env).completeAuth(code, state);
          return htmlPage('Authorization successful ✅', `The bot is re-authorized for @${username}. You can close this tab.`);
        } catch (err) {
          // Error message without any sensitive data (never a token).
          return htmlPage('Authorization failed ❌', err instanceof Error ? err.message : 'Unknown error.');
        }
      }

      case '/run': {
        if (request.method !== 'GET' || !hasValidKey(request, url, env)) return notFound();
        const result = await botStub(env).runDigestSafe();
        return new Response(`${result.ok ? 'OK' : 'FAILED'} — ${result.detail}\n`, {
          status: result.ok ? 200 : 500,
        });
      }

      case '/admin/import': {
        if (env.ADMIN_API !== 'on' || request.method !== 'POST' || !hasValidKey(request, url, env)) {
          return notFound();
        }
        let payload: { tokens?: unknown; state?: unknown };
        try {
          payload = (await request.json()) as { tokens?: unknown; state?: unknown };
        } catch {
          return new Response('Invalid JSON body\n', { status: 400 });
        }
        try {
          const detail = await botStub(env).importData(payload);
          return new Response(`${detail}\n`);
        } catch (err) {
          return new Response(`${err instanceof Error ? err.message : 'Import rejected'}\n`, {
            status: 400,
          });
        }
      }

      case '/admin/export': {
        if (env.ADMIN_API !== 'on' || request.method !== 'GET' || !hasValidKey(request, url, env)) {
          return notFound();
        }
        const data = await botStub(env).exportData();
        return Response.json(data);
      }

      default:
        return notFound();
    }
  },
};
