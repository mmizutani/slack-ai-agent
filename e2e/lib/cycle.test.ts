import { recordedToolCalls } from "./cycle";

const line = (n: number) =>
  `[INFO] [Tracking] Message processed: {"link":"x","ms":1,"toolCalls":${n}}`;

describe("recordedToolCalls", () => {
  it("reads the count from a tracking line", () => {
    expect(recordedToolCalls(line(3))).toBe(3);
  });

  it("reads zero as zero, not as absent", () => {
    // Zero means "a turn ran and used no tools", which is a failure for a tool
    // cycle. Absent means "no turn recorded yet". Conflating them would let a
    // tool cycle pass on a turn that never called anything.
    expect(recordedToolCalls(line(0))).toBe(0);
  });

  it("returns undefined when no turn has been recorded", () => {
    expect(recordedToolCalls("nothing here")).toBeUndefined();
  });

  it("uses the most recent turn when several are present", () => {
    expect(recordedToolCalls([line(5), line(2)].join("\n"))).toBe(2);
  });
});
