// npm run auth — flow OAuth 2.0 + PKCE (RFC 7636) contre l'API X, en LOCAL.
// Serveur éphémère sur 127.0.0.1 pour le callback, puis échange du code et
// écriture de tokens.json. Les briques OAuth partagées (PKCE, URLs, échange)
// vivent dans oauth.ts — le Worker (worker/index.ts) utilise les mêmes.

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, PROJECT_ROOT } from './config.ts';
import { FsStorage } from './fsStorage.ts';
import {
  buildAuthorizeUrl,
  codeChallengeS256,
  exchangeCode,
  generateCodeVerifier,
  randomStateParam,
} from './oauth.ts';
import { escapeHtml } from './telegram.ts';
import type { Config, Tokens } from './types.ts';

// Ré-exports : tests et documentation des constantes du flow local.
export { AUTHORIZE_URL, SCOPES, buildAuthorizeUrl, codeChallengeS256, generateCodeVerifier } from './oauth.ts';

// 127.0.0.1 (pas localhost) : recommandation de la doc X pour le dev local
// (alignement 2026-06-12, cf. PLAN.md §5 et SPIKE-HOSTING.md §3.5).
export const REDIRECT_URI = 'http://127.0.0.1:8765/callback';

const CALLBACK_PORT = 8765;
const CALLBACK_TIMEOUT_MS = 5 * 60_000;

function htmlPage(title: string, detail: string): string {
  // detail peut porter le paramètre `error` du callback OAuth : échappé.
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family: system-ui; max-width: 32rem; margin: 4rem auto;">
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body></html>`;
}

function respondHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function openInBrowser(url: string): void {
  if (process.platform !== 'darwin') return;
  // Confort uniquement : si `open` échoue, l'URL affichée suffit.
  try {
    const child = spawn('open', [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // ignoré
  }
}

async function runAuthFlow(config: Config): Promise<Tokens> {
  const verifier = generateCodeVerifier();
  const state = randomStateParam();
  const challenge = await codeChallengeS256(verifier);
  const authorizeUrl = buildAuthorizeUrl(config.xClientId, state, challenge, REDIRECT_URI);

  return new Promise<Tokens>((resolve, reject) => {
    let settled = false;

    const server = http.createServer((req, res) => {
      void handleRequest(req, res);
    });

    const finish = (outcome: { tokens?: Tokens; error?: Error }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      if (outcome.tokens) resolve(outcome.tokens);
      else reject(outcome.error ?? new Error('Flow OAuth interrompu'));
    };

    const timer = setTimeout(() => {
      finish({ error: new Error('Aucun callback OAuth reçu en 5 minutes — flow abandonné') });
    }, CALLBACK_TIMEOUT_MS);

    async function handleRequest(
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ): Promise<void> {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${CALLBACK_PORT}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Introuvable');
        return;
      }

      const oauthError = url.searchParams.get('error');
      if (oauthError) {
        respondHtml(res, 400, htmlPage('Autorisation refusée', `X a renvoyé : ${oauthError}`));
        finish({ error: new Error(`Autorisation refusée par X : ${oauthError}`) });
        return;
      }
      if (url.searchParams.get('state') !== state) {
        respondHtml(
          res,
          400,
          htmlPage('Paramètre state invalide', 'Le callback ne correspond pas à cette session.'),
        );
        finish({
          error: new Error('Paramètre state inattendu dans le callback (possible CSRF) — flow abandonné'),
        });
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        respondHtml(res, 400, htmlPage('Callback invalide', 'Paramètre code manquant.'));
        finish({ error: new Error('Callback sans paramètre code — flow abandonné') });
        return;
      }

      try {
        const tokens = await exchangeCode(config, code, verifier, REDIRECT_URI);
        respondHtml(
          res,
          200,
          htmlPage('Autorisation réussie ✅', 'Tu peux fermer cet onglet et revenir au terminal.'),
        );
        finish({ tokens });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        respondHtml(
          res,
          500,
          htmlPage('Échec de l’échange du code ❌', 'Détails dans le terminal.'),
        );
        finish({ error: new Error(message) });
      }
    }

    server.on('error', (err) => {
      finish({
        error: new Error(
          `Serveur de callback impossible sur 127.0.0.1:${CALLBACK_PORT} : ${err.message} — un autre process occupe peut-être le port`,
        ),
      });
    });

    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      console.log('Ouvre cette URL dans un navigateur pour autoriser le bot :\n');
      console.log(`  ${authorizeUrl}\n`);
      console.log(`En attente du callback sur ${REDIRECT_URI} (5 min max)…`);
      openInBrowser(authorizeUrl);
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfig('auth');
  const storage = new FsStorage(PROJECT_ROOT);
  const tokens = await runAuthFlow(config);
  await storage.putTokens(tokens);
  console.log(`\nAuthentification réussie pour @${tokens.username ?? '?'} (id ${tokens.userId}).`);
  console.log(
    `Access token valable jusqu'au ${new Date(tokens.expiresAt).toLocaleString('fr-FR')}.`,
  );
  console.log(`Tokens enregistrés dans ${storage.tokensPath}.`);
}

// Exécution uniquement en script direct (`npm run auth`), pas à l'import
// (les tests importent les helpers purs ré-exportés ci-dessus).
const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err: unknown) => {
    console.error(`Échec de l'authentification : ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
