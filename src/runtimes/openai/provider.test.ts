import { createOpenAIRunner, createOpenAIProvider } from "./provider";

describe("OpenAI Agents SDK provider configuration", () => {
  it("constructs a Responses provider and disables tracing by default", () => {
    const provider = createOpenAIProvider({
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      organization: "org-test",
      project: "project-test",
    });
    const runner = createOpenAIRunner(provider);

    expect(runner.config.modelProvider).toBe(provider);
    expect(runner.config.tracingDisabled).toBe(true);
    expect(runner.config.traceIncludeSensitiveData).toBe(false);
  });
});
