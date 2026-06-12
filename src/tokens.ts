// Rotation des tokens OAuth 2.0 au-dessus de l'abstraction Storage.
// Le refresh token X est à USAGE UNIQUE (PLAN.md §6) : toute rotation est
// persistée via storage.putTokens immédiatement après le parse réussi.
// Aucun import node:* : ce module tourne en local ET sur le Worker.

import type { Storage } from './storage.ts';
import type { Config, Tokens } from './types.ts';

export const TOKEN_URL = 'https://api.x.com/2/oauth2/token';

/** Marge (ms) : on refresh si l'access token expire dans moins de 60 s. */
export const EXPIRY_MARGIN_MS = 60_000;

/** Validation grossière de la forme d'un jeu de tokens persisté. */
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

/** Vrai si l'access token expire dans moins de marginMs (ou est déjà expiré). */
export function isExpired(
  tokens: Pick<Tokens, 'expiresAt'>,
  nowMs: number,
  marginMs: number = EXPIRY_MARGIN_MS,
): boolean {
  return tokens.expiresAt - nowMs < marginMs;
}

/**
 * Prépare la requête vers le endpoint token : Basic auth si client
 * confidentiel (et pas de client_id dans le body), sinon client_id dans le
 * body (client public, PKCE seul). btoa (et pas Buffer) : dispo dans les
 * deux runtimes, les credentials OAuth sont ASCII.
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
 * Mappe la réponse JSON du endpoint token vers les champs token de Tokens.
 * fallbackRefreshToken : conservé si la réponse n'en contient pas (ne devrait
 * pas arriver avec le scope offline.access, mais on ne perd jamais le seul
 * refresh token valide).
 */
export function parseTokenResponse(
  payload: unknown,
  nowMs: number,
  fallbackRefreshToken?: string,
): Pick<Tokens, 'accessToken' | 'refreshToken' | 'expiresAt'> {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Réponse token invalide : pas un objet JSON');
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.access_token !== 'string' || p.access_token.length === 0) {
    throw new Error('Réponse token invalide : access_token manquant');
  }
  if (typeof p.expires_in !== 'number' || !Number.isFinite(p.expires_in)) {
    throw new Error('Réponse token invalide : expires_in manquant');
  }
  const refreshToken =
    typeof p.refresh_token === 'string' && p.refresh_token.length > 0
      ? p.refresh_token
      : fallbackRefreshToken;
  if (!refreshToken) {
    throw new Error(
      'Réponse token invalide : refresh_token manquant (scope offline.access requis)',
    );
  }
  return {
    accessToken: p.access_token,
    refreshToken,
    expiresAt: nowMs + p.expires_in * 1000,
  };
}

/**
 * Retourne un access token valide, en le rafraîchissant si nécessaire.
 * La rotation est persistée IMMÉDIATEMENT après le parse réussi : le refresh
 * token X est à usage unique, une rotation non persistée = re-auth manuelle.
 */
export async function getValidAccessToken(
  config: Config,
  storage: Storage,
): Promise<{ accessToken: string; userId: string }> {
  const tokens = await storage.getTokens();
  if (!tokens) {
    throw new Error(`Aucun token X enregistré — ${config.reauthHint}`);
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
      `Échec du refresh du token X (HTTP ${response.status}) : ${text.slice(0, 300)} — ` +
        `le refresh token est probablement consommé ou révoqué, ${config.reauthHint}`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(
      `Réponse du refresh X illisible (HTTP ${response.status}) : ${text.slice(0, 300)}`,
    );
  }

  const rotated = parseTokenResponse(payload, Date.now(), tokens.refreshToken);
  const next: Tokens = {
    ...rotated,
    userId: tokens.userId,
    username: tokens.username,
  };
  // Persistance immédiate, avant tout autre travail (usage unique).
  await storage.putTokens(next);
  return { accessToken: next.accessToken, userId: next.userId };
}
