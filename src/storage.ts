import type { BotState, Tokens } from './types.ts';

/**
 * Abstraction de persistance (SPIKE-HOSTING.md §4) : deux implémentations,
 * FsStorage (local, fsUtil atomique) et le Durable Object côté Worker (output
 * gates). Contrat commun : putTokens DOIT être durablement persisté quand la
 * promesse se résout — le refresh token X est à usage unique.
 */
export interface Storage {
  /** null si aucun token enregistré ; throw si présent mais invalide. */
  getTokens(): Promise<Tokens | null>;
  putTokens(tokens: Tokens): Promise<void>;
  /** null si premier run ; throw si présent mais invalide (alerter, pas réinitialiser). */
  getState(): Promise<BotState | null>;
  putState(state: BotState): Promise<void>;
}
