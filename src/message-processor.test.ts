jest.mock("./reaction-manager", () => ({
  REACTIONS: { THINKING: "thinking", TOOL_USE: "tool" },
}));

import { AgentEvent } from "./agent/events";
import { AgentRuntimeRegistry } from "./runtimes/registry";
import { MessageProcessor } from "./message-processor";

describe("MessageProcessor", () => {
  it("consumes normalized runtime events without provider SDK shapes", async () => {
    const runtime = {
      provider: "openai" as const,
      stream: async function* (): AsyncIterable<AgentEvent> {
        yield { type: "text_delta", text: "An answer" };
        yield {
          type: "tool_call",
          tool: { kind: "action", name: "create_pull_request" },
          arguments: { title: "Fix" },
          sideEffecting: true,
        };
        yield {
          type: "tool_result",
          output: "confirmation dialog has been posted",
          suppressReply: true,
          confirmationDialogPosted: true,
        };
        yield {
          type: "usage",
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        };
        yield {
          type: "terminal",
          outcome: "completed",
          finalText: "An answer",
        };
      },
    };
    const registry = new AgentRuntimeRegistry();
    registry.register(runtime);
    const channelConfig = {
      isConditionalReplyChannel: jest.fn().mockResolvedValue(false),
      shouldUseEphemeralMessaging: jest.fn().mockResolvedValue(false),
      getEphemeralTargetUsers: jest.fn().mockResolvedValue([]),
    } as any;
    const reactions = { updateReaction: jest.fn() } as any;
    const processor = new MessageProcessor(registry, reactions, channelConfig);
    const session = {
      userId: "U1",
      channelId: "C1",
      workingDirectory: "/tmp/work",
      providerState: {},
      lastActivity: new Date(),
    } as any;

    const result = await processor.processAgentStream(
      "question",
      session,
      new AbortController(),
      runtime,
      {
        channel: "C1",
        channelType: "channel",
        user: "U1",
      },
      "U1-C1-direct",
    );

    expect(result.messages).toContain("An answer");
    expect(result.confirmationDialogPosted).toBe(true);
    expect(result.tokenUsage).toEqual(
      expect.objectContaining({ inputTokens: 2, outputTokens: 3 }),
    );
    expect(result.provider).toBe("openai");
  });

  it("passes request-scoped tool policy to the provider runtime", async () => {
    let requestPermissions: unknown;
    const runtime = {
      provider: "openai" as const,
      stream: async function* (request: any): AsyncIterable<AgentEvent> {
        requestPermissions = request.permissions;
        yield { type: "terminal", outcome: "completed" };
      },
    };
    const registry = new AgentRuntimeRegistry();
    registry.register(runtime);
    const channelConfig = {
      isConditionalReplyChannel: jest.fn().mockResolvedValue(false),
      shouldUseEphemeralMessaging: jest.fn().mockResolvedValue(false),
      getEphemeralTargetUsers: jest.fn().mockResolvedValue([]),
    } as any;
    const processor = new MessageProcessor(registry, {} as any, channelConfig);
    const session = {
      userId: "U1", channelId: "C1", workingDirectory: "/tmp/work",
      providerState: {}, lastActivity: new Date(),
    } as any;
    const permissionPolicy = {
      role: "member",
      allowed: ["workspace/read_file"],
      denied: [],
    };

    await processor.processAgentStream(
      "question", session, new AbortController(), runtime, undefined,
      undefined, undefined, undefined, undefined, { permissionPolicy },
    );

    expect(requestPermissions).toEqual(permissionPolicy);
  });

  it("returns a bounded message when the runtime reaches its turn limit without text", async () => {
    const runtime = {
      provider: "openai" as const,
      stream: async function* (): AsyncIterable<AgentEvent> {
        yield {
          type: "terminal",
          outcome: "limit" as const,
          reason: "max_turns",
        };
      },
    };
    const channelConfig = {
      isConditionalReplyChannel: jest.fn().mockResolvedValue(false),
      shouldUseEphemeralMessaging: jest.fn().mockResolvedValue(false),
      getEphemeralTargetUsers: jest.fn().mockResolvedValue([]),
    } as any;
    const processor = new MessageProcessor(
      new AgentRuntimeRegistry(),
      {} as any,
      channelConfig,
    );
    const session = {
      userId: "U1",
      channelId: "C1",
      workingDirectory: "/tmp/work",
      providerState: {},
      lastActivity: new Date(),
    } as any;

    const result = await processor.processAgentStream(
      "question",
      session,
      new AbortController(),
      runtime,
    );

    expect(result.messages).toEqual([
      "I ran out of turns before finishing this task. Please try a narrower request or ask a human to raise the cap.",
    ]);
  });

  it("turns a failed terminal into a generic user-facing error", async () => {
    const runtime = {
      provider: "openai" as const,
      stream: async function* (): AsyncIterable<AgentEvent> {
        yield {
          type: "terminal",
          outcome: "failed" as const,
          reason: "provider-private-secret",
        };
      },
    };
    const channelConfig = {
      isConditionalReplyChannel: jest.fn().mockResolvedValue(false),
      shouldUseEphemeralMessaging: jest.fn().mockResolvedValue(false),
      getEphemeralTargetUsers: jest.fn().mockResolvedValue([]),
    } as any;
    const processor = new MessageProcessor(
      new AgentRuntimeRegistry(),
      {} as any,
      channelConfig,
    );
    const session = {
      userId: "U1",
      channelId: "C1",
      workingDirectory: "/tmp/work",
      providerState: {},
      lastActivity: new Date(),
    } as any;

    const result = await processor.processAgentStream(
      "question",
      session,
      new AbortController(),
      runtime,
    );

    expect(result.failed).toBe(true);
    expect(result.messages).toEqual([
      "❌ Something went wrong while processing your request. Please try again.",
    ]);
    expect(result.messages.join(" ")).not.toContain("provider-private-secret");
  });

  it("preserves a posted action confirmation when the runtime later fails", async () => {
    const runtime = {
      provider: "openai" as const,
      stream: async function* (): AsyncIterable<AgentEvent> {
        yield {
          type: "tool_result",
          output: "confirmation posted",
          confirmationDialogPosted: true,
          suppressReply: true,
        };
        yield { type: "terminal", outcome: "failed" as const };
      },
    };
    const channelConfig = {
      isConditionalReplyChannel: jest.fn().mockResolvedValue(false),
      shouldUseEphemeralMessaging: jest.fn().mockResolvedValue(false),
      getEphemeralTargetUsers: jest.fn().mockResolvedValue([]),
    } as any;
    const processor = new MessageProcessor(
      new AgentRuntimeRegistry(),
      {} as any,
      channelConfig,
    );
    const session = {
      userId: "U1",
      channelId: "C1",
      workingDirectory: "/tmp/work",
      providerState: {},
      lastActivity: new Date(),
    } as any;

    const result = await processor.processAgentStream(
      "question",
      session,
      new AbortController(),
      runtime,
    );

    expect(result.messages).toEqual([]);
    expect(result.shouldNotRespond).toBe(true);
    expect(result.confirmationDialogPosted).toBe(true);
  });
});
