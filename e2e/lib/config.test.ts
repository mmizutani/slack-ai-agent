import { isDisposableChannelName, parseFlags, PreflightError } from "./config";

describe("parseFlags", () => {
  it("defaults to no restrictions", () => {
    expect(parseFlags([])).toEqual({
      providers: [],
      cycles: [],
      keep: false,
    });
  });

  it("collects repeated providers and cycles", () => {
    const flags = parseFlags([
      "--provider",
      "openai",
      "--cycle",
      "dm",
      "--cycle",
      "reactions",
    ]);
    expect(flags.providers).toEqual(["openai"]);
    expect(flags.cycles).toEqual(["dm", "reactions"]);
  });

  it("rejects an unknown provider instead of silently running both", () => {
    expect(() => parseFlags(["--provider", "gemini"])).toThrow(PreflightError);
  });

  it("rejects a flag missing its value", () => {
    expect(() => parseFlags(["--channel"])).toThrow(PreflightError);
  });

  it("rejects an unknown flag rather than ignoring a typo", () => {
    expect(() => parseFlags(["--chanel", "C1"])).toThrow(PreflightError);
  });

  it("accepts a positive timeout", () => {
    expect(parseFlags(["--timeout", "5000"]).timeoutMs).toBe(5000);
  });

  it.each(["abc", "0", "-1", ""])(
    "rejects a non-positive or non-numeric timeout: %p",
    value => {
      // Number("abc") is NaN and Number("") is 0; both used to be assigned
      // straight through, and a NaN deadline makes every wait expire at once,
      // so every cycle fails with a timeout that never really elapsed.
      expect(() => parseFlags(["--timeout", value])).toThrow(PreflightError);
    },
  );
});

describe("isDisposableChannelName", () => {
  it.each([
    "test",
    "tests",
    "testing",
    "slack-ai-agent-test",
    "e2e_test_channel",
  ])("accepts a channel whose name carries test as its own word: %p", name => {
    expect(isDisposableChannelName(name)).toBe(true);
  });

  it.each(["latest-releases", "protest-planning", "greatest-hits", "attest"])(
    "rejects a channel that merely contains the letters: %p",
    name => {
      // "latest".includes("test") is true — a substring check would have let
      // this suite post to, and delete from, #latest-releases.
      expect(isDisposableChannelName(name)).toBe(false);
    },
  );

  it("rejects an empty or unknown name rather than failing open", () => {
    expect(isDisposableChannelName("")).toBe(false);
    expect(isDisposableChannelName(undefined)).toBe(false);
  });
});
