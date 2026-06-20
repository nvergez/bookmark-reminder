// OAuth 2.0 + PKCE (RFC 7636) building blocks shared between the local CLI (auth.ts)
// and the Cloudflare Worker: WebCrypto and fetch only, no node:* imports
// — the same code runs in both runtimes.

import { TOKEN_URL, buildTokenRequest, parseTokenResponse } from './tokens.ts';
import type { Config, Tokens } from './types.ts';

export const AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
export const SCOPES = 'tweet.read users.read bookmark.read like.read offline.access';

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** code_verifier RFC 7636: 48 random bytes → 64 base64url characters
 * (within the 43-128 window, fully "unreserved" alphabet). */
export function generateCodeVerifier(byteLength: number = 48): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** Anti-CSRF state parameter: 24 random bytes in base64url. */
export function randomStateParam(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** code_challenge S256: base64url(sha256(ascii(verifier))), without padding.
 * Async because of WebCrypto (the only hash API common to Node/Workers). */
export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function buildAuthorizeUrl(
  clientId: string,
  state: string,
  codeChallenge: string,
  redirectUri: string,
): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function fetchMe(accessToken: string): Promise<{ id: string; username: string }> {
  const response = await fetch('https://api.x.com/2/users/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET /2/users/me failed (HTTP ${response.status}): ${text.slice(0, 300)}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Unreadable /2/users/me response: ${text.slice(0, 300)}`);
  }
  const data = (payload as { data?: { id?: unknown; username?: unknown } }).data;
  if (typeof data?.id !== 'string' || typeof data.username !== 'string') {
    throw new Error('Unexpected /2/users/me response: id or username missing');
  }
  return { id: data.id, username: data.username };
}

/** Exchanges the authorization code, then resolves the identity (/2/users/me)
 * — done only once here: the daily digest never pays for this call. */
export async function exchangeCode(
  config: Pick<Config, 'xClientId' | 'xClientSecret'>,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<Tokens> {
  const { headers, body } = buildTokenRequest(config, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const response = await fetch(TOKEN_URL, { method: 'POST', headers, body });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OAuth code exchange refused (HTTP ${response.status}): ${text.slice(0, 300)}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Unreadable token response: ${text.slice(0, 300)}`);
  }
  const parsed = parseTokenResponse(payload, Date.now());
  const me = await fetchMe(parsed.accessToken);
  return { ...parsed, userId: me.id, username: me.username };
}
