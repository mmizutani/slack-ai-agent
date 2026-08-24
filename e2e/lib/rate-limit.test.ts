import { retryDelayMs } from "./rate-limit";

describe("retryDelayMs", () => {
  it("honours Retry-After in seconds", () => {
    expect(retryDelayMs("3")).toBe(3000);
  });

  it("falls back to one second when the header is absent", () => {
    expect(retryDelayMs(null)).toBe(1000);
  });

  it("falls back when the header is not a number", () => {
    expect(retryDelayMs("soon")).toBe(1000);
  });

  it("ignores a negative value rather than waiting forever backwards", () => {
    expect(retryDelayMs("-5")).toBe(1000);
  });

  it("caps an absurd value so cleanup cannot stall the run", () => {
    expect(retryDelayMs("3600")).toBe(30_000);
  });
});
