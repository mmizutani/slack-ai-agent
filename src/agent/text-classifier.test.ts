import { ProviderTextClassifier } from "./text-classifier";

describe("provider-neutral text classifier", () => {
  it("uses the selected provider runtime with tools and continuation disabled", async () => {
    const classify = jest.fn().mockResolvedValue({
      text: "YES",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const classifier = new ProviderTextClassifier({ classify } as any);

    await expect(
      classifier.classify("Can you help?", {
        model: { provider: "openai", model: "gpt-5.6-luna" },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      text: "YES",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(classify).toHaveBeenCalledWith(
      "Can you help?",
      expect.objectContaining({
        model: { provider: "openai", model: "gpt-5.6-luna" },
        tools: [],
        continuation: false,
      }),
    );
  });

  it("fails closed when the provider classifier errors", async () => {
    const classifier = new ProviderTextClassifier({
      classify: jest.fn().mockRejectedValue(new Error("timeout")),
    } as any);

    await expect(
      classifier.classify("hello", {
        model: { provider: "openai", model: "gpt-5.6-luna" },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("timeout");
  });
});
