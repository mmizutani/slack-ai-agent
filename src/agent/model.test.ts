import { parseModelRef } from "./model";

describe("parseModelRef", () => {
  it("keeps legacy unqualified models Anthropic", () => {
    expect(parseModelRef("claude-haiku-4-5")).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });
});
