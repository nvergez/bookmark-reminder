// OAuth 2.0 token rotation on top of the Storage abstraction.
// The X refresh token is SINGLE-USE (PLAN.md §6): every rotation is
// persisted via storage.putTokens immediately after a successful parse.
// No node:* imports: this module runs locally AND on the Worker.

import type { Storage } from './storage.ts';
import type { Config, Tokens } from './types.ts';

export const TOKEN_URL = 'https://api.x.com/2/oauth2/token';

/** Margin (ms): refresh if the access token expires in less than 60 s. */
export const EXPIRY_MARGIN_MS = 60_000;

/** Rough validation of the shape of a persisted token set. */
export function isValidTokens(value: unknown): value is Tokens {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.accessToken === 'string' &&
    v.accessToken.length > 0 &&
    typeof v.refreshToken === 'string' &&
    v.refreshToken.length > 0 &&
    typeof v.expiresAt === 'number' &&
    Number.isFinite(v.expiresAt) &&
    typeof v.userId === 'string' &&
    v.userId.length > 0 &&
    (v.username === undefined || typeof v.username === 'string')
  );
}

/** True if the access token expires in less than marginMs (or is already expired). */
export function isExpired(
  tokens: Pick<Tokens, 'expiresAt'>,
  nowMs: number,
  marginMs: number = EXPIRY_MARGIN_MS,
): boolean {
  return tokens.expiresAt - nowMs < marginMs;
}

/**
 * Builds the request to the token endpoint: Basic auth for a confidential
 * client (and no client_id in the body), otherwise client_id in the body
 * (public client, PKCE only). btoa (not Buffer): available in both runtimes,
 * and OAuth credentials are ASCII.
 */
export function buildTokenRequest(
  config: Pick<Config, 'xClientId' | 'xClientSecret'>,
  params: Record<string, string>,
): { headers: Record<string, string>; body: string } {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (config.xClientSecret) {
    headers['Authorization'] = `Basic ${btoa(`${config.xClientId}:${config.xClientSecret}`)}`;
  } else {
    body.set('client_id', config.xClientId);
  }
  return { headers, body: body.toString() };
}

/**
 * Maps the token endpoint's JSON response to the token fields of Tokens.
 * fallbackRefreshToken: kept if the response doesn't contain one (shouldn't
 * happen with the offline.access scope, but we never lose the only valid
 * refresh token).
 */
export function parseTokenResponse(
  payload: unknown,
  nowMs: number,
  fallbackRefreshToken?: string,
): Pick<Tokens, 'accessToken' | 'refreshToken' | 'expiresAt'> {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Invalid token response: not a JSON object');
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.access_token !== 'string' || p.access_token.length === 0) {
    throw new Error('Invalid token response: missing access_token');
  }
  if (typeof p.expires_in !== 'number' || !Number.isFinite(p.expires_in)) {
    throw new Error('Invalid token response: missing expires_in');
  }
  const refreshToken =
    typeof p.refresh_token === 'string' && p.refresh_token.length > 0
      ? p.refresh_token
      : fallbackRefreshToken;
  if (!refreshToken) {
    throw new Error(
      'Invalid token response: missing refresh_token (offline.access scope required)',
    );
  }
  return {
    accessToken: p.access_token,
    refreshToken,
    expiresAt: nowMs + p.expires_in * 1000,
  };
}

/**
 * Returns a valid access token, refreshing it if necessary.
 * The rotation is persisted IMMEDIATELY after a successful parse: the X
 * refresh token is single-use, and an unpersisted rotation = manual re-auth.
 */
export async function getValidAccessToken(
  config: Config,
  storage: Storage,
): Promise<{ accessToken: string; userId: string }> {
  const tokens = await storage.getTokens();
  if (!tokens) {
    throw new Error(`No X token stored — ${config.reauthHint}`);
  }
  if (!isExpired(tokens, Date.now())) {
    return { accessToken: tokens.accessToken, userId: tokens.userId };
  }

  const { headers, body } = buildTokenRequest(config, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
  });
  const response = await fetch(TOKEN_URL, { method: 'POST', headers, body });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `X token refresh failed (HTTP ${response.status}): ${text.slice(0, 300)} — ` +
        `the refresh token has probably been consumed or revoked, ${config.reauthHint}`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(
      `Unreadable X refresh response (HTTP ${response.status}): ${text.slice(0, 300)}`,
    );
  }

  const rotated = parseTokenResponse(payload, Date.now(), tokens.refreshToken);
  const next: Tokens = {
    ...rotated,
    userId: tokens.userId,
    username: tokens.username,
  };
  // Persist immediately, before any other work (single-use).
  await storage.putTokens(next);
  return { accessToken: next.accessToken, userId: next.userId };
}
