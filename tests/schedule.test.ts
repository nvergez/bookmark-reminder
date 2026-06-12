// Garde DST du double-cron UTC (SPIKE-HOSTING.md §5.3) : tester explicitement
// les deux branches été/hiver avec des dates forcées.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLocalTime } from '../src/schedule.ts';

const PARIS = 'Europe/Paris';

test('hiver (UTC+1) : le cron 07:30 UTC correspond à 08:30 Paris', () => {
  assert.equal(isLocalTime(Date.parse('2026-01-15T07:30:00Z'), '08:30', PARIS), true);
});

test('hiver : la branche 06:30 UTC (07:30 Paris) est ignorée', () => {
  assert.equal(isLocalTime(Date.parse('2026-01-15T06:30:00Z'), '08:30', PARIS), false);
});

test('été (UTC+2) : le cron 06:30 UTC correspond à 08:30 Paris', () => {
  assert.equal(isLocalTime(Date.parse('2026-07-15T06:30:00Z'), '08:30', PARIS), true);
});

test('été : la branche 07:30 UTC (09:30 Paris) est ignorée', () => {
  assert.equal(isLocalTime(Date.parse('2026-07-15T07:30:00Z'), '08:30', PARIS), false);
});

test('jours mêmes des changements d’heure 2026 : une seule branche déclenche', () => {
  // Passage à l'heure d'été : dimanche 29 mars 2026, 2h → 3h (UTC+2 dès 01:00 UTC).
  assert.equal(isLocalTime(Date.parse('2026-03-29T06:30:00Z'), '08:30', PARIS), true);
  assert.equal(isLocalTime(Date.parse('2026-03-29T07:30:00Z'), '08:30', PARIS), false);
  // Retour à l'heure d'hiver : dimanche 25 octobre 2026, 3h → 2h (UTC+1 dès 01:00 UTC).
  assert.equal(isLocalTime(Date.parse('2026-10-25T07:30:00Z'), '08:30', PARIS), true);
  assert.equal(isLocalTime(Date.parse('2026-10-25T06:30:00Z'), '08:30', PARIS), false);
});

test('minute différente : jamais déclenché', () => {
  assert.equal(isLocalTime(Date.parse('2026-01-15T07:31:00Z'), '08:30', PARIS), false);
});
