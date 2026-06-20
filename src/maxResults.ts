const MAX_RESULTS_DEFAULT = 25;
/** liked_tweets refuses max_results < 5 (bookmarks accepts 1): common bound
 * [5,100], with the same value being sent to both endpoints. */
const MAX_RESULTS_MIN = 5;
const MAX_RESULTS_MAX = 100;

/** PURE (testable). Empty or absent string → default; otherwise clamp [5,100]. */
export function parseMaxResults(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return MAX_RESULTS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return MAX_RESULTS_DEFAULT;
  return Math.min(MAX_RESULTS_MAX, Math.max(MAX_RESULTS_MIN, Math.trunc(parsed)));
}
