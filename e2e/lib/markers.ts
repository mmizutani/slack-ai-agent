import { randomUUID } from "crypto";

/**
 * Deterministic markers for live verification.
 *
 * A model's prose is not assertable, so every cycle instructs the bot to echo a
 * marker and asserts on that instead. Markers are per-run as well as per-cycle
 * so a reply left over from an earlier run — Slack keeps history, and a failed
 * run may not have finished cleaning up — can never satisfy a later one.
 */
const MARKER_PREFIX = "E2E";

/** Characters that may legitimately continue a marker token. */
const TOKEN_CHAR = /[A-Za-z0-9-]/;

/** Short, human-scannable id for one harness run. */
export function newRunId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

/** The exact string a cycle asks the bot to echo. */
export function markerFor(runId: string, cycleId: string): string {
  return `${MARKER_PREFIX}-${runId}-${cycleId}`;
}

/**
 * Whether `text` contains `marker` as a whole token.
 *
 * A plain `includes` would let the reply for cycle `dm-followup` satisfy cycle
 * `dm`, because one marker is a prefix of the other. Both edges are checked so
 * neither a prefix nor a suffix collision can turn a real failure green.
 */
export function containsMarker(text: string, marker: string): boolean {
  let from = 0;
  for (;;) {
    const index = text.indexOf(marker, from);
    if (index === -1) return false;

    const before = text[index - 1];
    const after = text[index + marker.length];
    const boundedLeft = before === undefined || !TOKEN_CHAR.test(before);
    const boundedRight = after === undefined || !TOKEN_CHAR.test(after);
    if (boundedLeft && boundedRight) return true;

    from = index + 1;
  }
}
