/** Longest a single rate-limited retry will wait. */
export const MAX_RETRY_DELAY_MS = 30_000;

/**
 * How long to wait before retrying a rate-limited Slack call.
 *
 * Slack sends `Retry-After` in whole seconds on a 429. The cap exists because
 * teardown runs in the finally block of a live run: an honest but enormous
 * Retry-After would leave the harness apparently hung after its results were
 * already known.
 */
export function retryDelayMs(retryAfterHeader: string | null): number {
  const seconds = Number(retryAfterHeader);
  if (!Number.isFinite(seconds) || seconds <= 0) return 1000;
  return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
}
