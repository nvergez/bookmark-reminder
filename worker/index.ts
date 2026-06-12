// Worker Cloudflare (PLAN.md E6, SPIKE-HOSTING.md §3-§4) : cron quotidien +
// routes d'auth OAuth hébergées. Le run ENTIER s'exécute dans le Durable
// Object : ses output gates retiennent tout message réseau sortant tant que
// la rotation du refresh token (storage.put) n'est pas flushée sur disque —
// l'équivalent cloud de l'écriture atomique locale (fsUtil.ts).

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
  /** Secret d'accès aux routes /auth, /run et /admin/*
   * (?k=… ou en-tête Authorization: Bearer). */
  AUTH_URL_KEY: string;
  // Vars (wrangler.jsonc)
  /** URL publique du Worker, pour le lien de re-auth dans les alertes. */
  BASE_URL?: string;
  /** Heure locale Europe/Paris du digest (défaut 08:30) — garde du double-cron. */
  DIGEST_PARIS_TIME?: string;
  MAX_RESULTS?: string;
  TWEET_LINK_DOMAIN?: string;
  /** « on » pendant la bascule local→cloud uniquement (import/export des
   * tokens) ; repasser à « off » + redéployer une fois la bascule faite. */
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
      `Secrets manquants sur le Worker : ${missing.join(', ')} — \`wrangler secret put <NOM>\``,
    );
  }
  const reauthHint = env.BASE_URL
    ? `ré-autorise ici : ${env.BASE_URL}/auth?k=${env.AUTH_URL_KEY}`
    : 'ouvre https://<worker>/auth?k=<AUTH_URL_KEY> pour ré-autoriser';
  return {
    xClientId: env.X_CLIENT_ID,
    xClientSecret: env.X_CLIENT_SECRET || null,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramChatId: env.TELEGRAM_CHAT_ID,
    maxResults: parseMaxResults(env.MAX_RESULTS),
    tweetLinkDomain: env.TWEET_LINK_DOMAIN || 'x.com',
    reauthHint,
  };
}

/** Comparaison en temps constant du secret d'URL (pas de node:crypto ici). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class BotDO extends DurableObject<Env> {
  // Adaptateur Storage au-dessus du stockage SQLite du DO. Les valeurs sont
  // des objets structurés (pas de JSON.stringify) ; la validation de forme
  // reste là pour attraper une corruption ou un import raté.
  private readonly botStorage: Storage = {
    getTokens: async (): Promise<Tokens | null> => {
      const value = await this.ctx.storage.get('tokens');
      if (value === undefined) return null;
      if (!isValidTokens(value)) {
        throw new Error('Tokens du Durable Object invalides — refais un import ou une auth');
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

  /** Promesse du run en vol. Les input gates du DO ne couvrent pas les
   * `await fetch()` : sans ce garde, un /run concurrent du cron pourrait
   * consommer deux fois le même refresh token X (à usage unique). */
  private running: Promise<{ ok: boolean; detail: string }> | null = null;

  /** Run quotidien complet. Ne throw jamais : l'échec part en alerte Telegram
   * (best-effort) et remonte en { ok: false } pour les logs. */
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

  /** Démarre un flow PKCE : persiste verifier/state, retourne l'URL X. */
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

  /** Termine le flow : vérifie le state (one-shot), échange le code, et
   * refuse un compte X différent de celui déjà connu (SPIKE §3.3). */
  async completeAuth(code: string, state: string): Promise<string> {
    const config = buildConfig(this.env);
    const pending = (await this.ctx.storage.get('pendingAuth')) as PendingAuth | undefined;
    if (!pending || Date.now() - pending.createdAt > PENDING_AUTH_TTL_MS) {
      await this.ctx.storage.delete('pendingAuth');
      throw new Error('Aucun flow d’auth en attente (ou expiré) — repasse par /auth');
    }
    if (!safeEqual(state, pending.state)) {
      // pendingAuth NON consommé : /callback est public, un state forgé ne
      // doit pas pouvoir annuler le flow légitime en cours.
      throw new Error('Paramètre state invalide (possible CSRF) — flow abandonné');
    }
    // One-shot : consommé dès que le state correspond (un state ne se rejoue pas).
    await this.ctx.storage.delete('pendingAuth');

    const tokens = await exchangeCode(config, code, pending.verifier, pending.redirectUri);
    const existing = await this.botStorage.getTokens().catch(() => null);
    if (existing && existing.userId !== tokens.userId) {
      throw new Error(
        `Compte X inattendu (@${tokens.username ?? tokens.userId}) — seuls les tokens du compte d’origine sont acceptés`,
      );
    }
    await this.botStorage.putTokens(tokens);
    return tokens.username ?? tokens.userId;
  }

  /** Seed de la bascule local→cloud (SPIKE §3.4) : tokens ET state. */
  async importData(payload: { tokens?: unknown; state?: unknown }): Promise<string> {
    if (!isValidTokens(payload.tokens)) {
      throw new Error('Import refusé : champ "tokens" absent ou de forme invalide');
    }
    if (payload.state === undefined) {
      throw new Error(
        'Import refusé : champ "state" manquant — sans lui le premier run cloud ré-établit la référence en silence (SPIKE-HOSTING.md §3.4)',
      );
    }
    const state = validateStateShape(payload.state, 'import');
    await this.ctx.storage.put('tokens', payload.tokens);
    await this.ctx.storage.put('state', state);
    return `import OK : tokens (@${payload.tokens.username ?? payload.tokens.userId}) + state (${state.bookmarkIds.length} bookmarks, ${state.likeIds.length} likes suivis)`;
  }

  /** Export symétrique, pour le rollback cloud→local (SPIKE §3.4 étape 5). */
  async exportData(): Promise<{ tokens: Tokens | null; state: BotState | null }> {
    return {
      tokens: ((await this.ctx.storage.get('tokens')) as Tokens | undefined) ?? null,
      state: ((await this.ctx.storage.get('state')) as BotState | undefined) ?? null,
    };
  }
}

function htmlPage(title: string, detail: string): Response {
  // title/detail peuvent porter des données externes (paramètre `error` du
  // callback OAuth, messages d'exception) : tout est échappé, CSP en défense
  // en profondeur.
  const body = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
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
  return new Response('Introuvable', { status: 404 });
}

/** Clé acceptée en en-tête Authorization (préféré : pas de secret dans les
 * URLs, que les invocation logs capturent) ou en ?k= (nécessaire au lien
 * /auth cliquable depuis une alerte Telegram). */
function hasValidKey(request: Request, url: URL, env: Env): boolean {
  const header = request.headers.get('Authorization') ?? '';
  const provided = header.startsWith('Bearer ')
    ? header.slice('Bearer '.length)
    : url.searchParams.get('k') ?? '';
  return safeEqual(provided, env.AUTH_URL_KEY ?? '');
}

/** Les erreurs d'auth embarquent le lien de re-auth complet (?k=<secret>) à
 * destination de l'alerte Telegram ; les logs Workers (persistés quand
 * observability est activée) ne doivent jamais contenir la clé. */
function redactKey(detail: string, env: Env): string {
  return env.AUTH_URL_KEY ? detail.replaceAll(env.AUTH_URL_KEY, '<AUTH_URL_KEY>') : detail;
}

function botStub(env: Env): DurableObjectStub<BotDO> {
  // Un singleton : toutes les requêtes et tous les crons parlent au même DO.
  return env.BOT_DO.get(env.BOT_DO.idFromName('bot'));
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const target = env.DIGEST_PARIS_TIME || '08:30';
    if (!isLocalTime(controller.scheduledTime, target, PARIS_TZ)) {
      // L'autre branche du double-cron UTC : à ignorer (SPIKE §4).
      console.log(`Cron ${controller.cron} ignoré (pas ${target} ${PARIS_TZ})`);
      return;
    }
    const result = await botStub(env).runDigestSafe();
    if (result.ok) {
      console.log(`Digest OK — ${result.detail}`);
    } else {
      // L'alerte Telegram est déjà partie (best-effort) ; le log reste pour wrangler tail.
      console.error(`Échec du run digest : ${redactKey(result.detail, env)}`);
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
        // Pas de ?k ici (X redirige sans) : la protection est le state one-shot.
        if (request.method !== 'GET') return notFound();
        const oauthError = url.searchParams.get('error');
        if (oauthError) {
          return htmlPage('Autorisation refusée', `X a renvoyé : ${oauthError}`);
        }
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (!code || !state) {
          return htmlPage('Callback invalide', 'Paramètres code/state manquants.');
        }
        try {
          const username = await botStub(env).completeAuth(code, state);
          return htmlPage('Autorisation réussie ✅', `Le bot est ré-autorisé pour @${username}. Tu peux fermer cet onglet.`);
        } catch (err) {
          // Message d'erreur sans aucune donnée sensible (jamais de token).
          return htmlPage('Échec de l’autorisation ❌', err instanceof Error ? err.message : 'Erreur inconnue.');
        }
      }

      case '/run': {
        if (request.method !== 'GET' || !hasValidKey(request, url, env)) return notFound();
        const result = await botStub(env).runDigestSafe();
        return new Response(`${result.ok ? 'OK' : 'ÉCHEC'} — ${result.detail}\n`, {
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
          return new Response('Corps JSON invalide\n', { status: 400 });
        }
        try {
          const detail = await botStub(env).importData(payload);
          return new Response(`${detail}\n`);
        } catch (err) {
          return new Response(`${err instanceof Error ? err.message : 'Import refusé'}\n`, {
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
