import { parseFlags, PreflightError } from "./config";

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
});
