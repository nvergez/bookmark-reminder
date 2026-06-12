// Tests des helpers purs de l'auth OAuth 2.0 + PKCE (aucun réseau, aucun fichier).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildAuthorizeUrl,
  codeChallengeS256,
  generateCodeVerifier,
  REDIRECT_URI,
  SCOPES,
} from '../src/auth.ts';
import {
  buildTokenRequest,
  EXPIRY_MARGIN_MS,
  isExpired,
  isValidTokens,
  parseTokenResponse,
} from '../src/tokens.ts';
import type { Tokens } from '../src/types.ts';

// --- PKCE ---

test('generateCodeVerifier : longueur dans la fenêtre RFC 7636 (43-128)', () => {
  const verifier = generateCodeVerifier();
  assert.ok(verifier.length >= 43 && verifier.length <= 128, `longueur ${verifier.length}`);
});

test('generateCodeVerifier : alphabet unreserved uniquement (base64url)', () => {
  const verifier = generateCodeVerifier();
  assert.match(verifier, /^[A-Za-z0-9\-._~]+$/);
});

test('generateCodeVerifier : aléatoire (deux appels diffèrent)', () => {
  assert.notEqual(generateCodeVerifier(), generateCodeVerifier());
});

test('codeChallengeS256 : conforme au vecteur de la RFC 7636 (annexe B)', async () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(await codeChallengeS256(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('codeChallengeS256 : base64url sans padding ni caractères base64 classiques', async () => {
  const challenge = await codeChallengeS256(generateCodeVerifier());
  assert.equal(challenge.length, 43); // sha256 = 32 octets → 43 chars base64url
  assert.match(challenge, /^[A-Za-z0-9\-_]+$/);
  assert.ok(!challenge.includes('='));
});

test("buildAuthorizeUrl : tous les paramètres OAuth attendus", () => {
  const url = new URL(buildAuthorizeUrl('client-123', 'state-abc', 'challenge-xyz', REDIRECT_URI));
  assert.equal(url.origin + url.pathname, 'https://x.com/i/oauth2/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'client-123');
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(url.searchParams.get('scope'), SCOPES);
  assert.equal(url.searchParams.get('state'), 'state-abc');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-xyz');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
});

// --- Expiration ---

const baseTokens: Tokens = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: 1_000_000,
  userId: '42',
};

test('isExpired : faux loin de l’expiration', () => {
  assert.equal(isExpired(baseTokens, baseTokens.expiresAt - EXPIRY_MARGIN_MS - 1), false);
});

test('isExpired : vrai dans la marge de 60 s', () => {
  assert.equal(isExpired(baseTokens, baseTokens.expiresAt - EXPIRY_MARGIN_MS + 1), true);
});

test('isExpired : vrai une fois expiré', () => {
  assert.equal(isExpired(baseTokens, baseTokens.expiresAt + 1), true);
});

// --- Mapping réponse token ---

test('parseTokenResponse : mappe access_token, refresh_token et expires_in', () => {
  const now = 1_700_000_000_000;
  const parsed = parseTokenResponse(
    { access_token: 'new-at', refresh_token: 'new-rt', expires_in: 7200, token_type: 'bearer' },
    now,
  );
  assert.deepEqual(parsed, {
    accessToken: 'new-at',
    refreshToken: 'new-rt',
    expiresAt: now + 7200 * 1000,
  });
});

test('parseTokenResponse : conserve le fallback si refresh_token absent', () => {
  const parsed = parseTokenResponse({ access_token: 'at', expires_in: 60 }, 0, 'old-rt');
  assert.equal(parsed.refreshToken, 'old-rt');
});

test('parseTokenResponse : rejette refresh_token absent sans fallback', () => {
  assert.throws(
    () => parseTokenResponse({ access_token: 'at', expires_in: 60 }, 0),
    /refresh_token/,
  );
});

test('parseTokenResponse : rejette access_token manquant ou payload non-objet', () => {
  assert.throws(() => parseTokenResponse({ expires_in: 60, refresh_token: 'rt' }, 0), /access_token/);
  assert.throws(() => parseTokenResponse('oops', 0), /objet JSON/);
  assert.throws(() => parseTokenResponse(null, 0), /objet JSON/);
});

test('parseTokenResponse : rejette expires_in manquant', () => {
  assert.throws(
    () => parseTokenResponse({ access_token: 'at', refresh_token: 'rt' }, 0),
    /expires_in/,
  );
});

// --- Requête token (client public vs confidentiel) ---

test('buildTokenRequest : client public → client_id dans le body, pas d’Authorization', () => {
  const { headers, body } = buildTokenRequest(
    { xClientId: 'cid', xClientSecret: null },
    { grant_type: 'refresh_token', refresh_token: 'rt' },
  );
  const params = new URLSearchParams(body);
  assert.equal(params.get('client_id'), 'cid');
  assert.equal(params.get('grant_type'), 'refresh_token');
  assert.equal(params.get('refresh_token'), 'rt');
  assert.equal(headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(headers['Authorization'], undefined);
});

test('buildTokenRequest : client confidentiel → Basic auth, pas de client_id dans le body', () => {
  const { headers, body } = buildTokenRequest(
    { xClientId: 'cid', xClientSecret: 'secret' },
    { grant_type: 'authorization_code', code: 'c' },
  );
  const params = new URLSearchParams(body);
  assert.equal(params.get('client_id'), null);
  assert.equal(
    headers['Authorization'],
    `Basic ${Buffer.from('cid:secret').toString('base64')}`,
  );
});

// --- Forme de tokens.json ---

test('isValidTokens : accepte la forme nominale, avec ou sans username', () => {
  assert.equal(isValidTokens(baseTokens), true);
  assert.equal(isValidTokens({ ...baseTokens, username: 'alice' }), true);
});

test('isValidTokens : rejette les formes invalides', () => {
  assert.equal(isValidTokens(null), false);
  assert.equal(isValidTokens('x'), false);
  assert.equal(isValidTokens({ ...baseTokens, accessToken: '' }), false);
  assert.equal(isValidTokens({ ...baseTokens, expiresAt: 'demain' }), false);
  assert.equal(isValidTokens({ ...baseTokens, userId: undefined }), false);
  assert.equal(isValidTokens({ ...baseTokens, username: 7 }), false);
});
