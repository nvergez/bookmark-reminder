// Tests purs d'atomicWriteFile : uniquement dans un tmpdir node:os.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from '../src/fsUtil.ts';

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'fsutil-test-'));
}

test('atomicWriteFile : écrit le contenu, mode 0600, aucun tmp résiduel', () => {
  const dir = tmpDir();
  const filePath = path.join(dir, 'tokens.json');

  atomicWriteFile(filePath, '{"secret":true}\n');

  assert.equal(readFileSync(filePath, 'utf8'), '{"secret":true}\n');
  assert.equal(statSync(filePath).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ['tokens.json']);
});

test('atomicWriteFile : écrase atomiquement un fichier existant', () => {
  const dir = tmpDir();
  const filePath = path.join(dir, 'state.json');

  atomicWriteFile(filePath, 'v1');
  atomicWriteFile(filePath, 'v2');

  assert.equal(readFileSync(filePath, 'utf8'), 'v2');
  assert.deepEqual(readdirSync(dir), ['state.json']);
});

test('atomicWriteFile : échec du rename → throw et tmp supprimé (pas de secret orphelin)', () => {
  const dir = tmpDir();
  // cible occupée par un répertoire NON VIDE : renameSync échoue sûrement
  const target = path.join(dir, 'tokens.json');
  mkdirSync(path.join(target, 'occupe'), { recursive: true });

  assert.throws(() => atomicWriteFile(target, 'secret'));
  // seul le répertoire-cible subsiste : aucun tokens.json.tmp-<pid> orphelin
  assert.deepEqual(readdirSync(dir), ['tokens.json']);
});
