import { CycleResult, summarize } from "./report";

const result = (over: Partial<CycleResult>): CycleResult => ({
  cycleId: "channel-mention",
  provider: "anthropic",
  status: "passed",
  durationMs: 1,
  ...over,
});

describe("summarize", () => {
  it("counts each status", () => {
    const s = summarize([
      result({ status: "passed" }),
      result({ status: "failed", detail: "no reply" }),
      result({ status: "skipped", gap: "stdio MCP unsupported on this path" }),
    ]);
    expect({ passed: s.passed, failed: s.failed, skipped: s.skipped }).toEqual({
      passed: 1,
      failed: 1,
      skipped: 1,
    });
  });

  it("exits zero only when nothing failed", () => {
    expect(summarize([result({ status: "passed" })]).exitCode).toBe(0);
    expect(
      summarize([result({ status: "failed", detail: "x" })]).exitCode,
    ).toBe(1);
  });

  it("treats a skip with a documented gap as non-fatal", () => {
    expect(
      summarize([result({ status: "skipped", gap: "documented reason" })])
        .exitCode,
    ).toBe(0);
  });

  it("fails a skip that documents no gap, so coverage cannot be dropped silently", () => {
    const s = summarize([result({ status: "skipped" })]);
    expect(s.exitCode).toBe(1);
    expect(s.undocumentedSkips).toEqual(["anthropic/channel-mention"]);
  });

  it("fails an empty run rather than reporting success for doing nothing", () => {
    expect(summarize([]).exitCode).toBe(1);
  });
});
