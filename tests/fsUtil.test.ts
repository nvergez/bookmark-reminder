// Pure tests for atomicWriteFile: only within a node:os tmpdir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from '../src/fsUtil.ts';

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'fsutil-test-'));
}

test('atomicWriteFile: writes the content, mode 0600, no leftover tmp', () => {
  const dir = tmpDir();
  const filePath = path.join(dir, 'tokens.json');

  atomicWriteFile(filePath, '{"secret":true}\n');

  assert.equal(readFileSync(filePath, 'utf8'), '{"secret":true}\n');
  assert.equal(statSync(filePath).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ['tokens.json']);
});

test('atomicWriteFile: atomically overwrites an existing file', () => {
  const dir = tmpDir();
  const filePath = path.join(dir, 'state.json');

  atomicWriteFile(filePath, 'v1');
  atomicWriteFile(filePath, 'v2');

  assert.equal(readFileSync(filePath, 'utf8'), 'v2');
  assert.deepEqual(readdirSync(dir), ['state.json']);
});

test('atomicWriteFile: rename failure → throws and tmp removed (no orphaned secret)', () => {
  const dir = tmpDir();
  // target occupied by a NON-EMPTY directory: renameSync is sure to fail
  const target = path.join(dir, 'tokens.json');
  mkdirSync(path.join(target, 'occupe'), { recursive: true });

  assert.throws(() => atomicWriteFile(target, 'secret'));
  // only the target directory remains: no orphaned tokens.json.tmp-<pid>
  assert.deepEqual(readdirSync(dir), ['tokens.json']);
});
