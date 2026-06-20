// UTC double-cron DST guard (SPIKE-HOSTING.md §5.3): explicitly test
// both the summer/winter branches with forced dates.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLocalTime } from '../src/schedule.ts';

const PARIS = 'Europe/Paris';

test('winter (UTC+1): the 07:30 UTC cron maps to 08:30 Paris', () => {
  assert.equal(isLocalTime(Date.parse('2026-01-15T07:30:00Z'), '08:30', PARIS), true);
});

test('winter: the 06:30 UTC branch (07:30 Paris) is ignored', () => {
  assert.equal(isLocalTime(Date.parse('2026-01-15T06:30:00Z'), '08:30', PARIS), false);
});

test('summer (UTC+2): the 06:30 UTC cron maps to 08:30 Paris', () => {
  assert.equal(isLocalTime(Date.parse('2026-07-15T06:30:00Z'), '08:30', PARIS), true);
});

test('summer: the 07:30 UTC branch (09:30 Paris) is ignored', () => {
  assert.equal(isLocalTime(Date.parse('2026-07-15T07:30:00Z'), '08:30', PARIS), false);
});

test('on the actual 2026 DST change days: only one branch fires', () => {
  // Spring forward: Sunday 29 March 2026, 2am → 3am (UTC+2 from 01:00 UTC).
  assert.equal(isLocalTime(Date.parse('2026-03-29T06:30:00Z'), '08:30', PARIS), true);
  assert.equal(isLocalTime(Date.parse('2026-03-29T07:30:00Z'), '08:30', PARIS), false);
  // Fall back: Sunday 25 October 2026, 3am → 2am (UTC+1 from 01:00 UTC).
  assert.equal(isLocalTime(Date.parse('2026-10-25T07:30:00Z'), '08:30', PARIS), true);
  assert.equal(isLocalTime(Date.parse('2026-10-25T06:30:00Z'), '08:30', PARIS), false);
});

test('different minute: never fires', () => {
  assert.equal(isLocalTime(Date.parse('2026-01-15T07:31:00Z'), '08:30', PARIS), false);
});
