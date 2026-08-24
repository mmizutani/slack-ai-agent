import { AnthropicTextClassifierBackend } from "./text-classifier";

describe("AnthropicTextClassifierBackend", () => {
  const request = (signal: AbortSignal) => ({
    model: { provider: "anthropic" as const, model: "claude-haiku-4-5" },
    signal,
    tools: [] as never[],
    continuation: false as const,
  });

  // Spawning the provider CLI only to tear it down costs a process and a
  // billable turn for a decision that has already been cancelled.
  it("does not start provider work when the signal is already aborted", async () => {
    const query = jest.fn();
    const controller = new AbortController();
    controller.abort();

    await expect(
      new AnthropicTextClassifierBackend(query).classify(
        "classify me",
        request(controller.signal),
      ),
    ).resolves.toEqual({ text: "" });
    expect(query).not.toHaveBeenCalled();
  });

  it("classifies through the provider when the signal is live", async () => {
    const query = jest.fn(async function* () {
      yield { type: "result", result: "YES", total_cost_usd: 0.0001 };
    });

    await expect(
      new AnthropicTextClassifierBackend(query as any).classify(
        "classify me",
        request(new AbortController().signal),
      ),
    ).resolves.toEqual({ text: "YES", costUsd: 0.0001 });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
