// Tests for the pure OAuth 2.0 + PKCE auth helpers (no network, no files).

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

test('generateCodeVerifier: length within the RFC 7636 window (43-128)', () => {
  const verifier = generateCodeVerifier();
  assert.ok(verifier.length >= 43 && verifier.length <= 128, `length ${verifier.length}`);
});

test('generateCodeVerifier: unreserved alphabet only (base64url)', () => {
  const verifier = generateCodeVerifier();
  assert.match(verifier, /^[A-Za-z0-9\-._~]+$/);
});

test('generateCodeVerifier: random (two calls differ)', () => {
  assert.notEqual(generateCodeVerifier(), generateCodeVerifier());
});

test('codeChallengeS256: matches the RFC 7636 test vector (appendix B)', async () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(await codeChallengeS256(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('codeChallengeS256: base64url with no padding or classic base64 characters', async () => {
  const challenge = await codeChallengeS256(generateCodeVerifier());
  assert.equal(challenge.length, 43); // sha256 = 32 bytes → 43 base64url chars
  assert.match(challenge, /^[A-Za-z0-9\-_]+$/);
  assert.ok(!challenge.includes('='));
});

test("buildAuthorizeUrl: all expected OAuth parameters", () => {
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

// --- Expiry ---

const baseTokens: Tokens = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: 1_000_000,
  userId: '42',
};

test('isExpired: false well before expiry', () => {
  assert.equal(isExpired(baseTokens, baseTokens.expiresAt - EXPIRY_MARGIN_MS - 1), false);
});

test('isExpired: true within the 60 s margin', () => {
  assert.equal(isExpired(baseTokens, baseTokens.expiresAt - EXPIRY_MARGIN_MS + 1), true);
});

test('isExpired: true once expired', () => {
  assert.equal(isExpired(baseTokens, baseTokens.expiresAt + 1), true);
});

// --- Token response mapping ---

test('parseTokenResponse: maps access_token, refresh_token and expires_in', () => {
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

test('parseTokenResponse: keeps the fallback when refresh_token is absent', () => {
  const parsed = parseTokenResponse({ access_token: 'at', expires_in: 60 }, 0, 'old-rt');
  assert.equal(parsed.refreshToken, 'old-rt');
});

test('parseTokenResponse: rejects absent refresh_token without fallback', () => {
  assert.throws(
    () => parseTokenResponse({ access_token: 'at', expires_in: 60 }, 0),
    /refresh_token/,
  );
});

test('parseTokenResponse: rejects missing access_token or non-object payload', () => {
  assert.throws(() => parseTokenResponse({ expires_in: 60, refresh_token: 'rt' }, 0), /access_token/);
  assert.throws(() => parseTokenResponse('oops', 0), /JSON object/);
  assert.throws(() => parseTokenResponse(null, 0), /JSON object/);
});

test('parseTokenResponse: rejects missing expires_in', () => {
  assert.throws(
    () => parseTokenResponse({ access_token: 'at', refresh_token: 'rt' }, 0),
    /expires_in/,
  );
});

// --- Token request (public vs confidential client) ---

test('buildTokenRequest: public client → client_id in the body, no Authorization', () => {
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

test('buildTokenRequest: confidential client → Basic auth, no client_id in the body', () => {
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

// --- tokens.json shape ---

test('isValidTokens: accepts the nominal shape, with or without username', () => {
  assert.equal(isValidTokens(baseTokens), true);
  assert.equal(isValidTokens({ ...baseTokens, username: 'alice' }), true);
});

test('isValidTokens: rejects invalid shapes', () => {
  assert.equal(isValidTokens(null), false);
  assert.equal(isValidTokens('x'), false);
  assert.equal(isValidTokens({ ...baseTokens, accessToken: '' }), false);
  assert.equal(isValidTokens({ ...baseTokens, expiresAt: 'demain' }), false);
  assert.equal(isValidTokens({ ...baseTokens, userId: undefined }), false);
  assert.equal(isValidTokens({ ...baseTokens, username: 7 }), false);
});
