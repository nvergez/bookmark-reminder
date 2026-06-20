// npm run auth — OAuth 2.0 + PKCE (RFC 7636) flow against the X API, LOCALLY.
// Ephemeral server on 127.0.0.1 for the callback, then code exchange and
// writing of tokens.json. The shared OAuth building blocks (PKCE, URLs, exchange)
// live in oauth.ts — the Worker (worker/index.ts) uses the same ones.

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

// Re-exports: tests and documentation of the local flow constants.
export { AUTHORIZE_URL, SCOPES, buildAuthorizeUrl, codeChallengeS256, generateCodeVerifier } from './oauth.ts';

// 127.0.0.1 (not localhost): X docs recommendation for local dev
// (aligned 2026-06-12, see PLAN.md §5 and SPIKE-HOSTING.md §3.5).
export const REDIRECT_URI = 'http://127.0.0.1:8765/callback';

const CALLBACK_PORT = 8765;
const CALLBACK_TIMEOUT_MS = 5 * 60_000;

function htmlPage(title: string, detail: string): string {
  // detail may carry the `error` parameter from the OAuth callback: escaped.
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
  // Convenience only: if `open` fails, the displayed URL is enough.
  try {
    const child = spawn('open', [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // ignored
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
      else reject(outcome.error ?? new Error('OAuth flow interrupted'));
    };

    const timer = setTimeout(() => {
      finish({ error: new Error('No OAuth callback received within 5 minutes — flow aborted') });
    }, CALLBACK_TIMEOUT_MS);

    async function handleRequest(
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ): Promise<void> {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${CALLBACK_PORT}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      const oauthError = url.searchParams.get('error');
      if (oauthError) {
        respondHtml(res, 400, htmlPage('Authorization denied', `X returned: ${oauthError}`));
        finish({ error: new Error(`Authorization denied by X: ${oauthError}`) });
        return;
      }
      if (url.searchParams.get('state') !== state) {
        respondHtml(
          res,
          400,
          htmlPage('Invalid state parameter', 'The callback does not match this session.'),
        );
        finish({
          error: new Error('Unexpected state parameter in the callback (possible CSRF) — flow aborted'),
        });
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        respondHtml(res, 400, htmlPage('Invalid callback', 'Missing code parameter.'));
        finish({ error: new Error('Callback without a code parameter — flow aborted') });
        return;
      }

      try {
        const tokens = await exchangeCode(config, code, verifier, REDIRECT_URI);
        respondHtml(
          res,
          200,
          htmlPage('Authorization successful ✅', 'You can close this tab and return to the terminal.'),
        );
        finish({ tokens });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        respondHtml(
          res,
          500,
          htmlPage('Code exchange failed ❌', 'Details in the terminal.'),
        );
        finish({ error: new Error(message) });
      }
    }

    server.on('error', (err) => {
      finish({
        error: new Error(
          `Could not start callback server on 127.0.0.1:${CALLBACK_PORT}: ${err.message} — another process may be occupying the port`,
        ),
      });
    });

    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      console.log('Open this URL in a browser to authorize the bot:\n');
      console.log(`  ${authorizeUrl}\n`);
      console.log(`Waiting for the callback on ${REDIRECT_URI} (5 min max)…`);
      openInBrowser(authorizeUrl);
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfig('auth');
  const storage = new FsStorage(PROJECT_ROOT);
  const tokens = await runAuthFlow(config);
  await storage.putTokens(tokens);
  console.log(`\nAuthentication successful for @${tokens.username ?? '?'} (id ${tokens.userId}).`);
  console.log(
    `Access token valid until ${new Date(tokens.expiresAt).toLocaleString('fr-FR')}.`,
  );
  console.log(`Tokens saved to ${storage.tokensPath}.`);
}

// Runs only as a direct script (`npm run auth`), not on import
// (the tests import the pure helpers re-exported above).
const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err: unknown) => {
    console.error(`Authentication failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
