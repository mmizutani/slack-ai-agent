import { ConversationSession } from "../../types";
import { ClaudeAgentRuntime } from "./runtime";

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe("ClaudeAgentRuntime", () => {
  it("passes a normalized request to Claude and emits a terminal event", async () => {
    const session: ConversationSession = {
      userId: "U1",
      channelId: "C1",
      workingDirectory: "/tmp/work",
      providerState: {},
      lastActivity: new Date(),
    };
    const streamQuery = jest.fn(async function* () {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "answer" }] },
      };
      yield { type: "result", subtype: "success", result: "answer" };
    });
    const handler = { streamQuery };
    const runtime = new ClaudeAgentRuntime(handler as any);
    const controller = new AbortController();

    const events = await collect(
      runtime.stream({
        prompt: "question",
        session,
        model: { provider: "anthropic", model: "claude-opus-5" },
        signal: controller.signal,
        maxTurns: 5,
        permissions: {},
        tools: {},
        metadata: { requestId: "r1", sessionKey: "s1" },
      }),
    );

    expect(streamQuery).toHaveBeenCalledWith(
      "question",
      session,
      expect.any(AbortController),
      undefined,
      expect.any(Function),
      undefined,
      { model: "claude-opus-5" },
    );
    expect(events).toContainEqual({ type: "text_delta", text: "answer" });
    expect(events.filter(event => (event as any).type === "terminal")).toHaveLength(1);
  });
});
