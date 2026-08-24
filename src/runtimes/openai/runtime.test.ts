import type { ConversationSession } from "../../types";
import { OpenAIAgentRuntime } from "./runtime";
import { buildWorkspaceTools } from "../../workspace/tools";
import type { SubagentDefinition } from "../../subagents/types";
import { MCPServerStreamableHttp } from "@openai/agents";

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe("OpenAIAgentRuntime", () => {
  it("fails closed when action definitions have no effective permission policy", async () => {
    const stream = Object.assign((async function* () {})(), {
      finalOutput: "ok",
      currentTurn: 1,
    });
    const run = jest.fn().mockResolvedValue(stream);
    const runtime = new OpenAIAgentRuntime({
      apiKey: "test-key",
      runner: { run } as any,
    });
    const session: ConversationSession = {
      userId: "U1",
      channelId: "C1",
      workingDirectory: "/tmp/work",
      providerState: {},
      lastActivity: new Date(),
    };

    await collect(
      runtime.stream({
        prompt: "create it",
        session,
        model: { provider: "openai", model: "gpt-5.6-luna" },
        signal: new AbortController().signal,
        maxTurns: 1,
        permissions: {},
        tools: {
          actionDefinitions: [
            {
              identity: {
                kind: "action",
                server: "custom-actions",
                name: "create-ticket",
              },
              name: "create-ticket",
              description: "Create a ticket",
              inputSchema: { type: "object", properties: {} },
              requiresApproval: true,
              invoke: jest.fn(),
            },
          ],
        },
        metadata: { requestId: "policy-1", sessionKey: "policy-thread" },
      }),
    );

    expect(run.mock.calls[0][0].tools).toEqual([]);
  });

  it("forwards the configured response-storage policy to the model", async () => {
    const stream = Object.assign((async function* () {})(), {
      finalOutput: "ok",
      currentTurn: 1,
    });
    const run = jest.fn().mockResolvedValue(stream);
    const runtime = new OpenAIAgentRuntime({
      apiKey: "test-key",
      runner: { run } as any,
      storeResponses: false,
      sessionMode: "sdk_session",
    });
    const session: ConversationSession = {
      userId: "U1",
      channelId: "C1",
      workingDirectory: "/tmp/work",
      providerState: {},
      lastActivity: new Date(),
    };

    await collect(
      runtime.stream({
        prompt: "private",
        session,
        model: { provider: "openai", model: "gpt-5.6-luna" },
        signal: new AbortController().signal,
        maxTurns: 1,
        permissions: {},
        tools: {},
        metadata: { requestId: "store-1", sessionKey: "store-thread" },
      }),
    );

    expect(run.mock.calls[0][0].modelSettings).toEqual(
      expect.objectContaining({ store: false }),
    );
  });

  it("binds an SDK session in sdk_session mode and reuses it for the thread", async () => {
    const makeStream = () =>
      Object.assign(
        (async function* () {
          yield {
            type: "raw_model_stream_event",
            data: {
              type: "response_done",
              response: { id: "response-sdk" },
            },
          };
        })(),
        {
          finalOutput: "ok",
          currentTurn: 1,
        },
      );
    const run = jest.fn().mockImplementation(async () => makeStream());
    const runtime = new OpenAIAgentRuntime({
      apiKey: "test-key",
      runner: { run } as any,
      sessionMode: "sdk_session",
    });
    const session: ConversationSession = {
      userId: "U1",
      channelId: "C1",
      workingDirectory: "/tmp/work",
      providerState: {},
      lastActivity: new Date(),
    };
    const request = {
      prompt: "continue",
      session,
      model: { provider: "openai" as const, model: "gpt-5.6-luna" },
      signal: new AbortController().signal,
      maxTurns: 4,
      permissions: {},
      tools: {},
      metadata: { requestId: "sdk-1", sessionKey: "thread-1" },
    };

    await collect(runtime.stream(request));
    await collect(
      runtime.stream({
        ...request,
        metadata: { ...request.metadata, requestId: "sdk-2" },
      }),
    );

    const firstSession = run.mock.calls[0][2].session;
    expect(firstSession).toBeDefined();
    expect(run.mock.calls[1][2].session).toBe(firstSession);
    expect(run.mock.calls[0][2].previousResponseId).toBeUndefined();
  });

  it("evicts and clears the least-recent SDK session at the configured bound", async () => {
    const makeStream = () =>
      Object.assign((async function* () {})(), {
        finalOutput: "ok",
        currentTurn: 1,
      });
    const run = jest.fn().mockImplementation(async () => makeStream());
    const runtime = new OpenAIAgentRuntime({
      apiKey: "test-key",
      runner: { run } as any,
      sessionMode: "sdk_session",
      maxSdkSessions: 1,
    });
    const makeRequest = (sessionKey: string): any => ({
      prompt: "continue",
      session: {
        userId: "U1",
        channelId: "C1",
        workingDirectory: "/tmp/work",
        providerState: {},
        lastActivity: new Date(),
      },
      model: { provider: "openai", model: "gpt-5.6-luna" },
      signal: new AbortController().signal,
      maxTurns: 1,
      permissions: {},
      tools: {},
      metadata: { requestId: sessionKey, sessionKey },
    });

    await collect(runtime.stream(makeRequest("thread-1")));
    const firstSession = run.mock.calls[0][2].session;
    const clearSession = jest.spyOn(firstSession, "clearSession");
    await collect(runtime.stream(makeRequest("thread-2")));

    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[1][2].session).not.toBe(firstSession);
  });

  it("closes constructed MCP servers when later tool construction fails", async () => {
    const close = jest
      .spyOn(MCPServerStreamableHttp.prototype, "close")
      .mockResolvedValue(undefined);
    const runtime = new OpenAIAgentRuntime({
      apiKey: "test-key",
      runner: { run: jest.fn() } as any,
    });
    const session: ConversationSession = {
      userId: "U1",
      channelId: "C1",
      workingDirectory: "/tmp/work",
      providerState: {},
      lastActivity: new Date(),
    };

    const events = await collect(
      runtime.stream({
        prompt: "run",
        session,
        model: { provider: "openai", model: "gpt-5.6-luna" },
        signal: new AbortController().signal,
        maxTurns: 1,
        permissions: {},
        tools: {
          mcpDefinitions: [
            {
              name: "remote",
              transport: "streamable_http",
              url: "https://mcp.example",
            },
          ],
          actionDefinitions: [
            {
              identity: {
                kind: "action",
                server: "custom-actions",
                name: "broken",
              },
              name: "broken",
              description: "Broken schema",
              inputSchema: null as any,
              requiresApproval: false,
              invoke: jest.fn(),
            },
          ],
          permissionPolicy: {
            allowed: ["action:custom-actions/broken"],
            denied: [],
          },
        },
        metadata: { requestId: "cleanup", sessionKey: "cleanup" },
      }),
    );

    expect(close).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "terminal",
        outcome: "failed",
      }),
    );
    close.mockRestore();
  });

  it("uses Agent/Runner Responses streaming and carries prior response continuation", async () => {
    const stream = Object.assign(
      (async function* () {
        yield {
          type: "raw_model_stream_event",
          data: { type: "output_text_delta", delta: "answer" },
        };
        yield {
          type: "raw_model_stream_event",
          data: {
            type: "response_done",
            response: {
              id: "resp-next",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          },
        };
      })(),
      { finalOutput: "answer", currentTurn: 1 },
    );
    const run = jest.fn().mockResolvedValue(stream);
    const runtime = new OpenAIAgentRuntime({
      apiKey: "test-key",
      runner: { run } as any,
      sessionMode: "previous_response_id",
    });
    const session: ConversationSession = {
      userId: "U1",
      channelId: "C1",
      workingDirectory: "/tmp/work",
      providerState: {
        openai: {
          provider: "openai",
          mode: "previous_response_id",
          previousResponseId: "resp-prev",
        },
      },
      lastActivity: new Date(),
    };

    const events = await collect(
      runtime.stream({
        prompt: "follow up",
        session,
        model: { provider: "openai", model: "gpt-5.6-luna" },
        signal: new AbortController().signal,
        maxTurns: 4,
        permissions: {},
        tools: {},
        metadata: { requestId: "r1", sessionKey: "s1" },
      }),
    );

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ name: "slack-ai-agent" }),
      "follow up",
      expect.objectContaining({
        stream: true,
        maxTurns: 4,
        previousResponseId: "resp-prev",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(events).toContainEqual({ type: "text_delta", text: "answer" });
    expect(session.providerState.openai).toEqual({
      provider: "openai",
      mode: "previous_response_id",
      previousResponseId: "resp-next",
    });
  });

  it("retries one transient pre-run failure", async () => {
    const stream = Object.assign(
      (async function* () {
        yield {
          type: "raw_model_stream_event",
          data: { type: "output_text_delta", delta: "ok" },
        };
      })(),
      { finalOutput: "ok", currentTurn: 1 },
    );
    const transient = Object.assign(new Error("upstream unavailable"), {
      status: 503,
    });
    const run = jest
      .fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce(stream);
    const runtime = new OpenAIAgentRuntime({
      runner: { run } as any,
      apiKey: "test-key",
    });
    const session: ConversationSession = {
      userId: "U1",
      channelId: "C1",
      workingDirectory: "/tmp/work",
      providerState: {},
      lastActivity: new Date(),
    };

    const events = await collect(
      runtime.stream({
        prompt: "retry",
        session,
        model: { provider: "openai", model: "gpt-5.6-luna" },
        signal: new AbortController().signal,
        maxTurns: 4,
        permissions: {},
        tools: {},
        metadata: { requestId: "r2", sessionKey: "s2" },
      }),
    );

    expect(run).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual({ type: "text_delta", text: "ok" });
  });

  it("does not retry a stream failure after a side-effecting tool call", async () => {
    const stream = (async function* () {
      yield {
        type: "run_item_stream_event",
        name: "tool_called",
        item: {
          rawItem: {
            type: "function_call",
            callId: "call-1",
            name: "create_ticket",
            arguments: "{}",
          },
        },
      };
      throw new Error("connection lost after tool call");
    })();
    const run = jest.fn().mockResolvedValue(stream);
    const runtime = new OpenAIAgentRuntime({
      runner: { run } as any,
      apiKey: "test-key",
    });
    const session: ConversationSession = {
      userId: "U1",
      channelId: "C1",
      workingDirectory: "/tmp/work",
      providerState: {},
      lastActivity: new Date(),
    };

    const events = await collect(
      runtime.stream({
        prompt: "do it",
        session,
        model: { provider: "openai", model: "gpt-5.6-luna" },
        signal: new AbortController().signal,
        maxTurns: 4,
        permissions: {},
        tools: {},
        metadata: { requestId: "r3", sessionKey: "s3" },
      }),
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "terminal", outcome: "failed" }),
    );
  });

  it("exposes only explicitly authorized workspace tools and lets deny win", async () => {
    const stream = Object.assign((async function* () {})(), {
      finalOutput: "ok",
      currentTurn: 1,
    });
    const run = jest.fn().mockResolvedValue(stream);
    const runtime = new OpenAIAgentRuntime({
      runner: { run } as any,
      apiKey: "test-key",
    });
    const session: ConversationSession = {
      userId: "U1",
      channelId: "C1",
      workingDirectory: "/tmp/work",
      providerState: {},
      lastActivity: new Date(),
    };
    const tools = buildWorkspaceTools("/tmp/work");
    const request = {
      prompt: "read the file",
      session,
      model: { provider: "openai" as const, model: "gpt-5.6-luna" },
      signal: new AbortController().signal,
      maxTurns: 4,
      permissions: {},
      tools: {
        workspaceTools: tools,
        permissionPolicy: {
          allowed: ["workspace/read_file", "workspace/search_text"],
          denied: ["workspace/read_file"],
        },
      },
      metadata: { requestId: "r4", sessionKey: "s4" },
    };

    await collect(runtime.stream(request));

    const agent = run.mock.calls[0][0];
    expect(agent.tools.map((tool: any) => tool.name)).toEqual([
      "workspace_search_text",
    ]);
  });

  it("adds manager-style subagents with the parent tool policy", async () => {
    const stream = Object.assign((async function* () {})(), {
      finalOutput: "ok",
      currentTurn: 1,
    });
    const run = jest.fn().mockResolvedValue(stream);
    const runtime = new OpenAIAgentRuntime({
      runner: { run } as any,
      apiKey: "test-key",
    });
    const session: ConversationSession = {
      userId: "U1",
      channelId: "C1",
      workingDirectory: "/tmp/work",
      providerState: {},
      lastActivity: new Date(),
    };
    const definition: SubagentDefinition = {
      name: "validator",
      description: "Validate",
      model: { provider: "openai", model: "gpt-5.6-luna" },
      instructions: "Validate the answer",
      tools: ["workspace/read_file"],
    };

    await collect(
      runtime.stream({
        prompt: "delegate",
        session,
        model: { provider: "openai", model: "gpt-5.6-luna" },
        signal: new AbortController().signal,
        maxTurns: 4,
        permissions: {},
        tools: {
          workspaceTools: buildWorkspaceTools("/tmp/work"),
          subagentDefinitions: [definition],
          permissionPolicy: { allowed: ["workspace/read_file"], denied: [] },
        },
        metadata: { requestId: "r5", sessionKey: "s5" },
      }),
    );

    expect(run.mock.calls[0][0].tools.map((tool: any) => tool.name)).toContain(
      "subagent__validator",
    );
  });

  describe("MCP connect", () => {
    const session = (): ConversationSession => ({
      userId: "U1",
      channelId: "C1",
      workingDirectory: "/tmp/work",
      providerState: {},
      lastActivity: new Date(),
    });

    const fakeServer = (connect: () => Promise<void>) => ({
      name: "configured",
      connect: jest.fn(connect),
      close: jest.fn().mockResolvedValue(undefined),
    });

    it("closes already-connected servers when another connect rejects", async () => {
      const run = jest.fn();
      const runtime = new OpenAIAgentRuntime({
        apiKey: "test-key",
        runner: { run } as any,
      });
      const connected = fakeServer(async () => undefined);
      const failing = fakeServer(async () => {
        throw new Error("connect refused");
      });

      const events = await collect(
        runtime.stream({
          prompt: "hi",
          session: session(),
          model: { provider: "openai", model: "gpt-5.6-luna" },
          signal: new AbortController().signal,
          maxTurns: 1,
          permissions: {},
          tools: { mcpServers: [connected, failing] },
          metadata: { requestId: "mcp-1", sessionKey: "mcp-thread-1" },
        }),
      );

      expect(events).toContainEqual(
        expect.objectContaining({ type: "terminal", outcome: "failed" }),
      );
      // The failure path returned before the finally block, so a server that
      // did connect stayed open for the lifetime of the process.
      expect(connected.close).toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    });

    it("gives up on a stalled connect instead of hanging the request", async () => {
      const run = jest.fn();
      const runtime = new OpenAIAgentRuntime({
        apiKey: "test-key",
        runner: { run } as any,
        mcpConnectTimeoutMs: 10,
      });
      const stalled = fakeServer(() => new Promise<void>(() => undefined));

      const events = await collect(
        runtime.stream({
          prompt: "hi",
          session: session(),
          model: { provider: "openai", model: "gpt-5.6-luna" },
          signal: new AbortController().signal,
          maxTurns: 1,
          permissions: {},
          tools: { mcpServers: [stalled] },
          metadata: { requestId: "mcp-2", sessionKey: "mcp-thread-2" },
        }),
      );

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "terminal",
          outcome: "failed",
          reason: expect.stringMatching(/timed out/i),
        }),
      );
      expect(stalled.close).toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    });

    it("stops waiting on connect when the request is aborted", async () => {
      const run = jest.fn();
      const runtime = new OpenAIAgentRuntime({
        apiKey: "test-key",
        runner: { run } as any,
      });
      const controller = new AbortController();
      const stalled = fakeServer(() => new Promise<void>(() => undefined));
      setTimeout(() => controller.abort(), 10);

      const events = await collect(
        runtime.stream({
          prompt: "hi",
          session: session(),
          model: { provider: "openai", model: "gpt-5.6-luna" },
          signal: controller.signal,
          maxTurns: 1,
          permissions: {},
          tools: { mcpServers: [stalled] },
          metadata: { requestId: "mcp-3", sessionKey: "mcp-thread-3" },
        }),
      );

      expect(events).toContainEqual({
        type: "terminal",
        outcome: "cancelled",
        reason: "aborted",
      });
      expect(stalled.close).toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    });
  });
});
