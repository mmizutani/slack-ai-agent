import { adaptOpenAIStream } from "./event-adapter";

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe("OpenAI stream event adapter", () => {
  it("normalizes text, function-tool lifecycle, usage, continuation, and one terminal event", async () => {
    const source = (async function* () {
      yield {
        type: "raw_model_stream_event",
        data: { type: "output_text_delta", delta: "hello" },
      };
      yield {
        type: "run_item_stream_event",
        name: "tool_called",
        item: {
          rawItem: {
            type: "function_call",
            callId: "call-1",
            name: "lookup",
            arguments: '{"q":"status"}',
          },
        },
      };
      yield {
        type: "run_item_stream_event",
        name: "tool_output",
        item: {
          rawItem: {
            type: "function_call_result",
            callId: "call-1",
            name: "lookup",
            output: "ready",
          },
        },
      };
      yield {
        type: "raw_model_stream_event",
        data: {
          type: "response_done",
          response: {
            id: "resp-1",
            usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
          },
        },
      };
    })();

    const events = await collect(
      adaptOpenAIStream(source, {
        sessionMode: "previous_response_id",
        result: { finalOutput: "hello", currentTurn: 2 },
      }),
    );

    expect(events).toContainEqual({ type: "text_delta", text: "hello" });
    expect(events).toContainEqual({
      type: "tool_call",
      callId: "call-1",
      tool: { kind: "provider_native", name: "lookup" },
      arguments: { q: "status" },
      sideEffecting: false,
    });
    expect(events).toContainEqual({
      type: "tool_result",
      callId: "call-1",
      tool: { kind: "provider_native", name: "lookup" },
      output: "ready",
    });
    expect(events).toContainEqual({
      type: "usage",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, requests: 1 },
    });
    expect(events).toContainEqual({
      type: "session_update",
      state: {
        provider: "openai",
        mode: "previous_response_id",
        previousResponseId: "resp-1",
      },
    });
    expect(events).toContainEqual({
      type: "terminal",
      outcome: "completed",
      finalText: "hello",
      turnCount: 2,
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, requests: 1 },
    });
    expect(
      events.filter(event => (event as any).type === "terminal"),
    ).toHaveLength(1);
  });

  // A multi-turn run emits one response_done per response. Reporting only the
  // last response's usage undercounts the run in tracking and cost reporting.
  it("accumulates usage across responses", async () => {
    const response = (id: string, input: number, output: number) => ({
      type: "raw_model_stream_event",
      data: {
        type: "response_done",
        response: {
          id,
          usage: { inputTokens: input, outputTokens: output },
        },
      },
    });
    const events = await collect(
      adaptOpenAIStream(
        (async function* () {
          yield response("resp-1", 10, 4);
          yield response("resp-2", 7, 3);
        })(),
        { result: { finalOutput: "done", currentTurn: 2 } },
      ),
    );

    const usageEvents = events.filter(
      event => (event as any).type === "usage",
    ) as any[];
    expect(usageEvents.map(event => event.usage)).toEqual([
      { requests: 1, inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      { requests: 2, inputTokens: 17, outputTokens: 7, totalTokens: 24 },
    ]);
    expect(events[events.length - 1]).toEqual(
      expect.objectContaining({
        type: "terminal",
        usage: {
          requests: 2,
          inputTokens: 17,
          outputTokens: 7,
          totalTokens: 24,
        },
      }),
    );
  });

  it("classifies aborts and max-turn failures as terminal outcomes", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await collect(
      adaptOpenAIStream((async function* () {})(), {
        signal: controller.signal,
        result: { finalOutput: undefined, currentTurn: 0 },
      }),
    );

    expect(events).toContainEqual({
      type: "terminal",
      outcome: "cancelled",
      reason: "aborted",
    });
  });

  it("emits SDK-session state without requiring a response id", async () => {
    const source = (async function* () {
      yield {
        type: "raw_model_stream_event",
        data: { type: "response_done", response: {} },
      };
    })();

    const events = await collect(
      adaptOpenAIStream(source, {
        sessionMode: "sdk_session",
        sessionKey: "thread-1",
      }),
    );

    expect(events).toContainEqual({
      type: "session_update",
      state: {
        provider: "openai",
        mode: "sdk_session",
        sessionKey: "thread-1",
      },
    });
  });

  it("uses the resolved MCP tool name for identity and side-effect classification", async () => {
    const source = (async function* () {
      yield {
        type: "run_item_stream_event",
        name: "tool_called",
        item: {
          rawItem: {
            type: "function_call",
            callId: "call-1",
            name: "mcp__release_ops__get_status",
            arguments: "{}",
          },
        },
      };
    })();

    const events = await collect(adaptOpenAIStream(source));

    expect(events).toContainEqual({
      type: "tool_call",
      callId: "call-1",
      tool: { kind: "mcp", server: "release_ops", name: "get_status" },
      arguments: {},
      sideEffecting: false,
    });
  });

  it("parses action server names containing underscores", async () => {
    const source = (async function* () {
      yield {
        type: "run_item_stream_event",
        name: "tool_called",
        item: {
          rawItem: {
            type: "function_call",
            callId: "call-2",
            name: "action__custom_actions__create_ticket",
            arguments: "{}",
          },
        },
      };
    })();

    const events = await collect(adaptOpenAIStream(source));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_call",
        tool: {
          kind: "action",
          server: "custom_actions",
          name: "create_ticket",
        },
      }),
    );
  });

  it("bounds the wait for SDK stream settlement", async () => {
    const completed = new Promise<void>(resolve => setTimeout(resolve, 50));
    const events = await collect(
      adaptOpenAIStream((async function* () {})(), {
        result: { completed },
        settlementTimeoutMs: 1,
      }),
    );

    expect(events).toContainEqual({
      type: "terminal",
      outcome: "failed",
      reason: "OpenAI stream settlement timed out",
    });
  });

  // `completed` is the SDK run promise. Both the settlement timeout and a throw
  // from the stream loop leave the generator without ever awaiting it, and Node
  // terminates the process on an unhandled rejection.
  it.each([
    {
      label: "the settlement wait times out",
      stream: (async function* () {})(),
    },
    {
      label: "the stream loop throws",
      stream: (async function* () {
        throw new Error("stream failed");
      })(),
    },
  ])("handles the run promise rejection when $label", async ({ stream }) => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let failRun: (error: Error) => void = () => undefined;
      const completed = new Promise<void>((_resolve, reject) => {
        failRun = reject;
      });

      await collect(
        adaptOpenAIStream(stream, {
          result: { completed },
          settlementTimeoutMs: 1,
        }),
      );

      failRun(new Error("run rejected after the generator returned"));
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });
});
