import { AgentEvent } from "../../agent/events";
import { adaptAnthropicStream } from "./event-adapter";

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe("Anthropic event adapter", () => {
  it("normalizes text, tools, usage, session state, and one terminal event", async () => {
    const events = await collect(
      adaptAnthropicStream([
        { type: "system", subtype: "init", session_id: "s1" },
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "hello" },
              {
                type: "tool_use",
                id: "call-1",
                name: "Read",
                input: { file_path: "notes.txt" },
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "call-1",
                content: "confirmation dialog has been posted",
              },
            ],
          },
        },
        {
          type: "result",
          subtype: "success",
          result: "hello",
          usage: { input_tokens: 2, output_tokens: 3 },
          total_cost_usd: 0.01,
        },
      ]),
    );

    expect(events).toEqual(
      expect.arrayContaining([
        { type: "session_update", state: { provider: "anthropic", sessionId: "s1" } },
        { type: "text_delta", text: "hello" },
        expect.objectContaining({
          type: "tool_call",
          callId: "call-1",
          tool: { kind: "provider_native", name: "Read" },
        }),
        expect.objectContaining({
          type: "tool_result",
          callId: "call-1",
          suppressReply: true,
          confirmationDialogPosted: true,
        }),
        expect.objectContaining({
          type: "usage",
          usage: expect.objectContaining({
            inputTokens: 2,
            outputTokens: 3,
            totalTokens: 5,
          }),
        }),
      ]),
    );
    const terminals = events.filter(event => event.type === "terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toEqual(
      expect.objectContaining({ type: "terminal", outcome: "completed" }),
    );
  });

  it("maps provider limit results to a limit terminal", async () => {
    const events = await collect(
      adaptAnthropicStream([
        { type: "result", subtype: "error_max_turns" },
      ]),
    );

    expect(events).toContainEqual({
      type: "terminal",
      outcome: "limit",
      reason: "error_max_turns",
    });
  });

  it("emits only one terminal when a provider sends duplicate result messages", async () => {
    const events = await collect(
      adaptAnthropicStream([
        { type: "result", subtype: "success", result: "first" },
        { type: "result", subtype: "success", result: "duplicate" },
      ]),
    );

    expect(events.filter(event => event.type === "terminal")).toHaveLength(1);
  });

  it("parses MCP server names containing underscores", async () => {
    const events = await collect(
      adaptAnthropicStream([{
        type: "assistant",
        message: { content: [{
          type: "tool_use",
          id: "call-1",
          name: "mcp__release_ops__get_status",
          input: {},
        }] },
      } as any]),
    );

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_call",
      tool: { kind: "mcp", server: "release_ops", name: "get_status" },
    }));
  });

  it("fails closed for an unknown result subtype", async () => {
    const events = await collect(
      adaptAnthropicStream([{
        type: "result",
        subtype: "future_provider_error",
      } as any]),
    );

    expect(events).toContainEqual({
      type: "terminal",
      outcome: "failed",
      reason: "future_provider_error",
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "terminal", outcome: "completed" }),
    );
  });
});
