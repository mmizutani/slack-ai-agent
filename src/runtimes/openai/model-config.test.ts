import {
  DEFAULT_OPENAI_MODEL,
  resolveOpenAIModel,
} from "./model-config";

describe("OpenAI model configuration", () => {
  it("uses OPENAI_MODEL when configured", () => {
    expect(resolveOpenAIModel({ OPENAI_MODEL: "gateway-deployment" })).toBe(
      "gateway-deployment",
    );
  });

  it("uses the production default when OPENAI_MODEL is absent", () => {
    expect(resolveOpenAIModel({})).toBe(DEFAULT_OPENAI_MODEL);
  });
});
