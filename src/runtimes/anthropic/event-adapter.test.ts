import { AgentEvent } from "../../agent/events";
import { adaptAnthropicStream } from "./event-adapter";

async function collect(
  events: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe("Anthropic event adapter", () => {
  // Breaking out of `for await` after the terminal runs the source iterator's
  // cleanup. A throw from there must not be reported as a second terminal —
  // MessageProcessor keeps the last one it sees, so a completed run would be
  // rewritten into a failure and the user would get the generic error.
  it("keeps one terminal when the source iterator throws during cleanup", async () => {
    const source = {
      [Symbol.asyncIterator]() {
        let sent = false;
        return {
          async next() {
            if (sent) return { value: undefined, done: true as const };
            sent = true;
            return {
              value: {
                type: "result",
                subtype: "success",
                result: "done",
              } as any,
              done: false as const,
            };
          },
          async return() {
            throw new Error("source cleanup failed");
          },
        };
      },
    };

    const events = await collect(adaptAnthropicStream(source as any));

    const terminals = events.filter(event => event.type === "terminal");
    expect(terminals).toEqual([
      expect.objectContaining({ outcome: "completed", finalText: "done" }),
    ]);
  });

  // The in-process custom-action MCP server returns these flags as
  // structuredContent (see runtimes/anthropic/action-adapter). The SDK surfaces
  // the full tool Output object on the user message as tool_use_result, not on
  // the nested tool_result block, so prose matching is only the fallback.
  it("reads lifecycle flags from tool_use_result rather than the tool text", async () => {
    const events = await collect(
      adaptAnthropicStream([
        {
          type: "user",
          tool_use_result: {
            content: [{ type: "text", text: "Posted." }],
            structuredContent: {
              suppressReply: true,
              confirmationDialogPosted: true,
            },
          },
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "call-1",
                content: "Posted.",
              },
            ],
          },
        },
      ] as any),
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_result",
          callId: "call-1",
          suppressReply: true,
          confirmationDialogPosted: true,
        }),
      ]),
    );
  });

  it("reads lifecycle flags from a flat tool_use_result payload", async () => {
    const events = await collect(
      adaptAnthropicStream([
        {
          type: "user",
          tool_use_result: { suppressReply: true },
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "call-2",
                content: "Done.",
              },
            ],
          },
        },
      ] as any),
    );

    const toolResult = events.find(event => event.type === "tool_result");
    expect(toolResult).toEqual(
      expect.objectContaining({ callId: "call-2", suppressReply: true }),
    );
    expect(toolResult).not.toHaveProperty("confirmationDialogPosted");
  });

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
        {
          type: "session_update",
          state: { provider: "anthropic", sessionId: "s1" },
        },
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
      adaptAnthropicStream([{ type: "result", subtype: "error_max_turns" }]),
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
      adaptAnthropicStream([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "call-1",
                name: "mcp__release_ops__get_status",
                input: {},
              },
            ],
          },
        } as any,
      ]),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_call",
        tool: { kind: "mcp", server: "release_ops", name: "get_status" },
      }),
    );
  });

  it("fails closed for an unknown result subtype", async () => {
    const events = await collect(
      adaptAnthropicStream([
        {
          type: "result",
          subtype: "future_provider_error",
        } as any,
      ]),
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
