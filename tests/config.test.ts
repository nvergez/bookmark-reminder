// Tests purs du parsing de MAX_RESULTS (loadConfig touche .env/env, pas testable purement).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMaxResults } from '../src/config.ts';

test('parseMaxResults : absent ou vide → défaut 25', () => {
  assert.equal(parseMaxResults(undefined), 25);
  assert.equal(parseMaxResults(''), 25); // MAX_RESULTS= laissé vide dans .env
  assert.equal(parseMaxResults('   '), 25);
});

test('parseMaxResults : valeurs valides conservées (tronquées si décimales)', () => {
  assert.equal(parseMaxResults('5'), 5);
  assert.equal(parseMaxResults('25'), 25);
  assert.equal(parseMaxResults('100'), 100);
  assert.equal(parseMaxResults('42.9'), 42);
});

test('parseMaxResults : clamp [5,100] — liked_tweets refuse < 5 (HTTP 400)', () => {
  assert.equal(parseMaxResults('0'), 5);
  assert.equal(parseMaxResults('1'), 5);
  assert.equal(parseMaxResults('4'), 5);
  assert.equal(parseMaxResults('-3'), 5);
  assert.equal(parseMaxResults('101'), 100);
  assert.equal(parseMaxResults('9999'), 100);
});

test('parseMaxResults : non numérique → défaut 25', () => {
  assert.equal(parseMaxResults('beaucoup'), 25);
  assert.equal(parseMaxResults('NaN'), 25);
  assert.equal(parseMaxResults('Infinity'), 25);
});
