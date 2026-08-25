export type ProviderId = "anthropic" | "openai";

export type CycleStatus = "passed" | "failed" | "skipped";

export interface CycleResult {
  cycleId: string;
  provider: ProviderId;
  status: CycleStatus;
  durationMs: number;
  /** Why a cycle failed. */
  detail?: string;
  /** Why a cycle was skipped. Required for a skip to be acceptable. */
  gap?: string;
  /** Slack permalink or thread ts, for a human following up. */
  evidence?: string;
}

export interface RunSummary {
  passed: number;
  failed: number;
  skipped: number;
  /** "<provider>/<cycleId>" for every skip that documented no reason. */
  undocumentedSkips: string[];
  exitCode: 0 | 1;
}

/**
 * Reduce cycle results to a verdict.
 *
 * Two cases exit non-zero beyond an outright failure, because both would
 * otherwise let the suite report success while verifying less than it claims:
 * a skip that documents no gap, and a run that executed no cycles at all.
 */
export function summarize(results: readonly CycleResult[]): RunSummary {
  const passed = results.filter(r => r.status === "passed").length;
  const failed = results.filter(r => r.status === "failed").length;
  const skips = results.filter(r => r.status === "skipped");
  const undocumentedSkips = skips
    .filter(r => !r.gap?.trim())
    .map(r => `${r.provider}/${r.cycleId}`);

  const clean =
    results.length > 0 && failed === 0 && undocumentedSkips.length === 0;

  return {
    passed,
    failed,
    skipped: skips.length,
    undocumentedSkips,
    exitCode: clean ? 0 : 1,
  };
}

/** Human-readable one line per cycle, plus a verdict line. */
export function formatSummary(
  results: readonly CycleResult[],
  summary: RunSummary,
): string {
  const icon: Record<CycleStatus, string> = {
    passed: "PASS",
    failed: "FAIL",
    skipped: "SKIP",
  };
  const lines = results.map(r => {
    const suffix = r.detail ?? r.gap ?? "";
    return `  ${icon[r.status]}  ${r.provider.padEnd(9)} ${r.cycleId.padEnd(20)} ${String(r.durationMs).padStart(6)}ms${suffix ? `  ${suffix}` : ""}`;
  });
  lines.push(
    `  ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`,
  );
  for (const skip of summary.undocumentedSkips) {
    lines.push(`  undocumented skip: ${skip}`);
  }
  return lines.join("\n");
}
