// Local (filesystem) implementation of Storage: tokens.json + state.json at
// the project root, written via atomicWriteFile (tmp + fsync + rename).
// This is the launchd/CLI path — the Worker has its own (Durable Object).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './fsUtil.ts';
import { validateStateShape } from './state.ts';
import type { Storage } from './storage.ts';
import { isValidTokens } from './tokens.ts';
import type { BotState, Tokens } from './types.ts';

export class FsStorage implements Storage {
  readonly tokensPath: string;
  readonly statePath: string;

  constructor(rootDir: string) {
    this.tokensPath = path.join(rootDir, 'tokens.json');
    this.statePath = path.join(rootDir, 'state.json');
  }

  async getTokens(): Promise<Tokens | null> {
    let raw: string;
    try {
      raw = readFileSync(this.tokensPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `${this.tokensPath} corrupted (invalid JSON) — rerun \`npm run auth\` to regenerate it`,
      );
    }
    if (!isValidTokens(parsed)) {
      throw new Error(
        `${this.tokensPath} has an unexpected shape — rerun \`npm run auth\` to regenerate it`,
      );
    }
    return parsed;
  }

  async putTokens(tokens: Tokens): Promise<void> {
    atomicWriteFile(this.tokensPath, `${JSON.stringify(tokens, null, 2)}\n`);
  }

  async getState(): Promise<BotState | null> {
    if (!existsSync(this.statePath)) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.statePath, 'utf8'));
    } catch (cause) {
      throw new Error(
        `state.json unreadable (corrupted JSON): ${this.statePath} — deleting it would silently trigger a fresh first run, check its contents first`,
        { cause },
      );
    }
    return validateStateShape(parsed, this.statePath);
  }

  async putState(state: BotState): Promise<void> {
    atomicWriteFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}
