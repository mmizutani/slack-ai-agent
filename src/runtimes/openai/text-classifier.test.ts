import type { ModelRef } from "../../agent/model";
import { OpenAITextClassifierBackend } from "./text-classifier";

describe("OpenAITextClassifierBackend", () => {
  // A deployment that opts out of Responses storage must not have its
  // classifier transcripts retained: the Agent stores by default when the
  // setting is omitted.
  it("forwards the configured response-storage policy to the model", async () => {
    const stream = Object.assign((async function* () {})(), {
      finalOutput: "NO",
      currentTurn: 1,
    });
    const run = jest.fn().mockResolvedValue(stream);
    const backend = new OpenAITextClassifierBackend({
      runner: { run } as any,
      storeResponses: false,
    });

    await backend.classify("classify me", {
      model: { provider: "openai", model: "gpt-5.6-luna" },
      signal: new AbortController().signal,
      tools: [],
      continuation: false,
    });

    expect(run.mock.calls[0][0].modelSettings).toEqual(
      expect.objectContaining({ store: false }),
    );
  });

  it("runs one bounded no-tool Responses turn and returns text/usage", async () => {
    const stream = Object.assign(
      (async function* () {
        yield {
          type: "raw_model_stream_event",
          data: { type: "output_text_delta", delta: "YES" },
        };
        yield {
          type: "raw_model_stream_event",
          data: {
            type: "response_done",
            response: {
              usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
            },
          },
        };
      })(),
      { finalOutput: "YES", currentTurn: 1 },
    );
    const run = jest.fn().mockResolvedValue(stream);
    const backend = new OpenAITextClassifierBackend({
      runner: { run } as any,
    });
    const signal = new AbortController().signal;
    const model: ModelRef = { provider: "openai", model: "gpt-5.6-luna" };

    await expect(
      backend.classify("route this", {
        model,
        signal,
        tools: [],
        continuation: false,
      }),
    ).resolves.toMatchObject({
      text: "YES",
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ tools: [] }),
      "route this",
      expect.objectContaining({ stream: true, maxTurns: 1, signal }),
    );
  });
});
