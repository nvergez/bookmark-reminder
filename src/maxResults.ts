const MAX_RESULTS_DEFAULT = 25;
/** liked_tweets refuse max_results < 5 (bookmarks accepte 1) : borne commune
 * [5,100], la même valeur étant envoyée aux deux endpoints. */
const MAX_RESULTS_MIN = 5;
const MAX_RESULTS_MAX = 100;

/** PUR (testable). Chaîne vide ou absente → défaut ; sinon clamp [5,100]. */
export function parseMaxResults(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return MAX_RESULTS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return MAX_RESULTS_DEFAULT;
  return Math.min(MAX_RESULTS_MAX, Math.max(MAX_RESULTS_MIN, Math.trunc(parsed)));
}
