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
    expect(events.filter(event => (event as any).type === "terminal")).toHaveLength(1);
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
      state: { provider: "openai", mode: "sdk_session", sessionKey: "thread-1" },
    });
  });

  it("uses the resolved MCP tool name for identity and side-effect classification", async () => {
    const source = (async function* () {
      yield {
        type: "run_item_stream_event",
        name: "tool_called",
        item: { rawItem: {
          type: "function_call",
          callId: "call-1",
          name: "mcp__release_ops__get_status",
          arguments: "{}",
        } },
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
        item: { rawItem: {
          type: "function_call",
          callId: "call-2",
          name: "action__custom_actions__create_ticket",
          arguments: "{}",
        } },
      };
    })();

    const events = await collect(adaptOpenAIStream(source));
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_call",
      tool: { kind: "action", server: "custom_actions", name: "create_ticket" },
    }));
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
});
