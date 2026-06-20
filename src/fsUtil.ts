import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';

/**
 * Atomic write: tmp + fsync + rename on the same volume.
 * Essential for tokens.json (single-use X refresh token: a partial write means
 * manual re-auth, PLAN.md §6) and useful for state.json.
 * Mode 0600: these files contain secrets or private data.
 * On failure (disk full, rename impossible...), the temporary file is removed:
 * it would otherwise hold secrets in the version-controlled directory.
 */
export function atomicWriteFile(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  const fd = openSync(tmpPath, 'w', 0o600);
  try {
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // best effort: the original error takes precedence
    }
    throw err;
  }
}
