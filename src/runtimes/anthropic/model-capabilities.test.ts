import { getAnthropicModelCapabilities } from "./model-capabilities";

describe("Anthropic model capabilities", () => {
  it("detects Opus fast-mode support case-insensitively", () => {
    expect(
      getAnthropicModelCapabilities({
        provider: "anthropic",
        model: "CLAUDE-OPUS-5",
      }).supportsFastMode,
    ).toBe(true);
  });
});
