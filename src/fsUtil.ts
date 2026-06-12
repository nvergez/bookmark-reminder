import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';

/**
 * Écriture atomique : tmp + fsync + rename sur le même volume.
 * Indispensable pour tokens.json (refresh token X à usage unique : une
 * écriture partielle = re-auth manuelle, PLAN.md §6) et utile pour state.json.
 * Mode 0600 : ces fichiers contiennent des secrets ou des données privées.
 * En cas d'échec (disque plein, rename impossible…), le tmp est supprimé :
 * il contiendrait des secrets dans le répertoire versionné.
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
      // best effort : l'erreur d'origine prime
    }
    throw err;
  }
}
