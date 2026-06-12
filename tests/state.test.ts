import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FsStorage } from '../src/fsStorage.ts';
import { STATE_MAX_IDS, computeDiff } from '../src/state.ts';
import type { BotState, FetchResult, Tweet } from '../src/types.ts';

const NOW = '2026-06-12T08:30:00.000Z';

function tweet(id: string): Tweet {
  return {
    id,
    text: `tweet ${id}`,
    authorUsername: 'alice',
    authorName: 'Alice',
    createdAt: '2026-01-01T00:00:00.000Z',
    url: `https://x.com/alice/status/${id}`,
  };
}

function fetched(bookmarkIds: string[], likeIds: string[] = []): FetchResult {
  return { bookmarks: bookmarkIds.map(tweet), likes: likeIds.map(tweet) };
}

function state(bookmarkIds: string[], likeIds: string[] = []): BotState {
  return { bookmarkIds, likeIds, lastRunAt: '2026-06-11T08:30:00.000Z' };
}

test('premier run : isFirstRun, aucun nouveau, référence établie', () => {
  const { diff, nextState } = computeDiff(null, fetched(['b1', 'b2'], ['l1']), NOW);

  assert.equal(diff.isFirstRun, true);
  assert.deepEqual(diff.newBookmarks, []);
  assert.deepEqual(diff.newLikes, []);
  // les vrais totaux enregistrés sont exposés pour le récap Telegram
  assert.deepEqual(diff.trackedCounts, { bookmarks: 2, likes: 1 });
  assert.deepEqual(nextState.bookmarkIds, ['b1', 'b2']);
  assert.deepEqual(nextState.likeIds, ['l1']);
  assert.equal(nextState.lastRunAt, NOW);
});

test('nouveautés détectées : seuls les ids inconnus sont signalés', () => {
  const { diff, nextState } = computeDiff(state(['b1', 'b2']), fetched(['b3', 'b1', 'b2']), NOW);

  assert.equal(diff.isFirstRun, false);
  assert.deepEqual(
    diff.newBookmarks.map((t) => t.id),
    ['b3'],
  );
  assert.deepEqual(diff.trackedCounts, { bookmarks: 3, likes: 0 });
  assert.deepEqual(nextState.bookmarkIds, ['b3', 'b1', 'b2']);
});

test('item sorti de la fenêtre puis revenu : pas re-signalé', () => {
  // run 1 : b1 connu ; run 2 : b1 absent de la fenêtre (toujours bookmarké)
  const afterRun2 = computeDiff(state(['b1']), fetched(['b2']), NOW);
  assert.deepEqual(
    afterRun2.diff.newBookmarks.map((t) => t.id),
    ['b2'],
  );
  // b1 reste mémorisé après les ids fraîchement vus
  assert.deepEqual(afterRun2.nextState.bookmarkIds, ['b2', 'b1']);

  // run 3 : b1 réapparaît dans la fenêtre → silence
  const afterRun3 = computeDiff(afterRun2.nextState, fetched(['b1', 'b2']), NOW);
  assert.deepEqual(afterRun3.diff.newBookmarks, []);
  assert.deepEqual(afterRun3.nextState.bookmarkIds, ['b1', 'b2']);
});

test('plafond STATE_MAX_IDS : les plus récents survivent', () => {
  const oldIds = Array.from({ length: STATE_MAX_IDS }, (_, i) => `old-${i}`);
  const { nextState } = computeDiff(state(oldIds), fetched(['fresh-1', 'fresh-2']), NOW);

  assert.equal(nextState.bookmarkIds.length, STATE_MAX_IDS);
  assert.deepEqual(nextState.bookmarkIds.slice(0, 2), ['fresh-1', 'fresh-2']);
  // les 2 plus anciens sont évincés
  assert.ok(!nextState.bookmarkIds.includes(`old-${STATE_MAX_IDS - 1}`));
  assert.ok(!nextState.bookmarkIds.includes(`old-${STATE_MAX_IDS - 2}`));
  assert.ok(nextState.bookmarkIds.includes('old-0'));
});

test("ordre des nouveautés préservé (ordre API, plus récents d'abord)", () => {
  const { diff } = computeDiff(state(['b9']), fetched(['b3', 'b2', 'b9', 'b1']), NOW);
  assert.deepEqual(
    diff.newBookmarks.map((t) => t.id),
    ['b3', 'b2', 'b1'],
  );
});

test('bookmarks et likes diffés indépendamment', () => {
  const previous = state(['shared', 'b-only'], ['l-only']);
  const { diff, nextState } = computeDiff(
    previous,
    fetched(['shared', 'b-new'], ['shared', 'l-new']),
    NOW,
  );

  // « shared » est connu côté bookmarks mais pas côté likes
  assert.deepEqual(
    diff.newBookmarks.map((t) => t.id),
    ['b-new'],
  );
  assert.deepEqual(
    diff.newLikes.map((t) => t.id),
    ['shared', 'l-new'],
  );
  assert.deepEqual(nextState.bookmarkIds, ['shared', 'b-new', 'b-only']);
  assert.deepEqual(nextState.likeIds, ['shared', 'l-new', 'l-only']);
});

test('computeDiff est pur : previous et fetched non mutés', () => {
  const previous = state(['b1'], ['l1']);
  const result = fetched(['b2', 'b1'], ['l1']);
  const prevCopy = structuredClone(previous);
  const fetchedCopy = structuredClone(result);

  computeDiff(previous, result, NOW);

  assert.deepEqual(previous, prevCopy);
  assert.deepEqual(result, fetchedCopy);
});

test('FsStorage.getState : null si state.json absent', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'state-test-'));
  assert.equal(await new FsStorage(dir).getState(), null);
});

test('FsStorage : putState puis getState, aller-retour fidèle', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'state-test-'));
  const storage = new FsStorage(dir);
  const s = state(['b1', 'b2'], ['l1']);

  await storage.putState(s);
  assert.deepEqual(await storage.getState(), s);
});

test('state.json corrompu (JSON invalide) : throw explicite', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'state-test-'));
  writeFileSync(path.join(dir, 'state.json'), '{ pas du json', 'utf8');

  await assert.rejects(() => new FsStorage(dir).getState(), /state\.json illisible/);
});

test('state.json de forme invalide : throw explicite', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'state-test-'));
  const storage = new FsStorage(dir);

  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ bookmarkIds: 'oops' }), 'utf8');
  await assert.rejects(() => storage.getState(), /state invalide/);

  writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({ bookmarkIds: ['b1'], likeIds: [1, 2] }),
    'utf8',
  );
  await assert.rejects(() => storage.getState(), /state invalide/);

  writeFileSync(path.join(dir, 'state.json'), JSON.stringify([1, 2, 3]), 'utf8');
  await assert.rejects(() => storage.getState(), /state invalide/);
});
