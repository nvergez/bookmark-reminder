// Pure tests for MAX_RESULTS parsing (loadConfig touches .env/env, not purely testable).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMaxResults } from '../src/config.ts';

test('parseMaxResults: absent or empty → default 25', () => {
  assert.equal(parseMaxResults(undefined), 25);
  assert.equal(parseMaxResults(''), 25); // MAX_RESULTS= left empty in .env
  assert.equal(parseMaxResults('   '), 25);
});

test('parseMaxResults: valid values kept (truncated if decimal)', () => {
  assert.equal(parseMaxResults('5'), 5);
  assert.equal(parseMaxResults('25'), 25);
  assert.equal(parseMaxResults('100'), 100);
  assert.equal(parseMaxResults('42.9'), 42);
});

test('parseMaxResults: clamp [5,100] — liked_tweets rejects < 5 (HTTP 400)', () => {
  assert.equal(parseMaxResults('0'), 5);
  assert.equal(parseMaxResults('1'), 5);
  assert.equal(parseMaxResults('4'), 5);
  assert.equal(parseMaxResults('-3'), 5);
  assert.equal(parseMaxResults('101'), 100);
  assert.equal(parseMaxResults('9999'), 100);
});

test('parseMaxResults: non-numeric → default 25', () => {
  assert.equal(parseMaxResults('beaucoup'), 25);
  assert.equal(parseMaxResults('NaN'), 25);
  assert.equal(parseMaxResults('Infinity'), 25);
});
