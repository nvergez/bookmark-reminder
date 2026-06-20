import type { BotState, Tokens } from './types.ts';

/**
 * Persistence abstraction (SPIKE-HOSTING.md §4): two implementations,
 * FsStorage (local, atomic fsUtil) and the Durable Object on the Worker side (output
 * gates). Common contract: putTokens MUST be durably persisted when the
 * promise resolves — the X refresh token is single-use.
 */
export interface Storage {
  /** null if no token is stored; throw if present but invalid. */
  getTokens(): Promise<Tokens | null>;
  putTokens(tokens: Tokens): Promise<void>;
  /** null on first run; throw if present but invalid (alert, don't reset). */
  getState(): Promise<BotState | null>;
  putState(state: BotState): Promise<void>;
}
