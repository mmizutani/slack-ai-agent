import {
  Agent,
  MemorySession,
  type MCPServer,
  type Runner,
  type Session,
} from "@openai/agents";
import type {
  AgentRunRequest,
  RuntimeMcpServerHandle,
} from "../../agent/events";
import type { AgentRuntime } from "../../agent/runtime";
import { config } from "../../config";
import { buildOpenAIFunctionTools } from "./action-adapter";
import { buildOpenAIMcpServers } from "./mcp-adapter";
import { buildOpenAIWorkspaceTools } from "./workspace-adapter";
import type { SubagentDefinition } from "../../subagents/types";
import { buildOpenAISubagentTools } from "./subagent-adapter";
import {
  createOpenAIRunner,
  createOpenAIProvider,
  type OpenAIProviderConfig,
} from "./provider";
import { adaptOpenAIStream } from "./event-adapter";

export interface OpenAIRuntimeOptions extends OpenAIProviderConfig {
  runner?: Pick<Runner, "run">;
  provider?: ReturnType<typeof createOpenAIProvider>;
  sessionMode?: "previous_response_id" | "sdk_session";
  agentName?: string;
  subagentDefinitions?: readonly SubagentDefinition[];
  storeResponses?: boolean;
  maxSdkSessions?: number;
  mcpConnectTimeoutMs?: number;
}

// MCPServer.connect() takes no abort signal, so the wait has to be bounded from
// the outside. Without this, one unreachable MCP endpoint hangs the Slack turn
// indefinitely.
const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 30_000;

function isTransientPreRunFailure(error: unknown): boolean {
  const status = Number((error as any)?.status ?? (error as any)?.statusCode);
  if (status === 408 || status === 409 || status === 429 || status >= 500) {
    return true;
  }
  return /ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|temporar|unavailable/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

export class OpenAIAgentRuntime implements AgentRuntime {
  readonly provider = "openai" as const;
  private readonly providerClient;
  private readonly runner: Pick<Runner, "run">;
  private readonly sessionMode: "previous_response_id" | "sdk_session";
  private readonly agentName: string;
  private readonly subagentDefinitions: readonly SubagentDefinition[];
  private readonly sdkSessions = new Map<string, Session>();
  private readonly storeResponses: boolean;
  private readonly maxSdkSessions: number;
  private readonly mcpConnectTimeoutMs: number;

  constructor(options: OpenAIRuntimeOptions = {}) {
    this.providerClient =
      options.provider ??
      createOpenAIProvider({
        apiKey: options.apiKey ?? config.openai.apiKey,
        baseUrl: options.baseUrl ?? config.openai.baseUrl,
        organization: options.organization ?? config.openai.organization,
        project: options.project ?? config.openai.project,
      });
    this.runner =
      options.runner ??
      createOpenAIRunner(
        this.providerClient,
        options.tracingEnabled ?? config.openai.tracingEnabled,
      );
    this.sessionMode = options.sessionMode ?? config.openai.sessionMode;
    this.agentName = options.agentName ?? "slack-ai-agent";
    this.subagentDefinitions = options.subagentDefinitions ?? [];
    this.storeResponses =
      options.storeResponses ?? config.openai.storeResponses;
    this.maxSdkSessions = Math.max(1, options.maxSdkSessions ?? 1_000);
    this.mcpConnectTimeoutMs =
      options.mcpConnectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS;
  }

  /**
   * Connect every MCP server, bounded by the request signal and a timeout.
   * MCPServer.connect() accepts neither, so the bound is applied by racing the
   * combined connect against both.
   */
  private async connectMcpServers(
    servers: readonly RuntimeMcpServerHandle[],
    signal: AbortSignal,
  ): Promise<void> {
    if (servers.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        Promise.all(
          servers.map(server =>
            typeof server.connect === "function" ? server.connect() : undefined,
          ),
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("MCP server connect timed out")),
            this.mcpConnectTimeoutMs,
          );
          onAbort = () => reject(new Error("aborted"));
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  /** Release every request-scoped MCP server, whichever set it came from. */
  private async closeMcpServers(
    mcpBundle: { close(): Promise<void> },
    configuredMcpServers: readonly RuntimeMcpServerHandle[],
  ): Promise<void> {
    await mcpBundle.close();
    await Promise.allSettled(
      configuredMcpServers.map(server =>
        typeof server.close === "function" ? server.close() : undefined,
      ),
    );
  }

  async *stream(request: AgentRunRequest) {
    if (request.signal.aborted) {
      yield {
        type: "terminal",
        outcome: "cancelled",
        reason: "aborted",
      } as const;
      return;
    }

    const model = request.model.model || config.openai.model;
    const actionDefinitions = request.tools.actionDefinitions ?? [];
    const mcpDefinitions = request.tools.mcpDefinitions ?? [];
    const configuredPermissionPolicy =
      request.tools.permissionPolicy ?? request.permissions;
    const permissionPolicy = {
      allowed: [...(configuredPermissionPolicy?.allowed ?? [])],
      denied: [...(configuredPermissionPolicy?.denied ?? [])],
    };
    const mcpBundle = buildOpenAIMcpServers(mcpDefinitions, permissionPolicy);
    let configuredMcpServers: readonly RuntimeMcpServerHandle[] = [];
    let agent: any;
    try {
      configuredMcpServers = request.tools.mcpServers ?? [];
      const workspaceDefinitions = request.tools.workspaceTools ?? [];
      const providerTools = buildOpenAIWorkspaceTools(
        workspaceDefinitions,
        permissionPolicy,
      );
      const actionTools = buildOpenAIFunctionTools(
        actionDefinitions,
        permissionPolicy,
      );
      const subagentDefinitions =
        request.tools.subagentDefinitions ?? this.subagentDefinitions;
      const subagentTools = buildOpenAISubagentTools(
        subagentDefinitions,
        permissionPolicy,
        {
          parentModel: model,
          modelProvider: this.providerClient,
          availableTools: [...providerTools, ...actionTools],
        },
      );
      agent = new Agent({
        name: this.agentName,
        instructions:
          request.systemPrompt ??
          "You are a helpful Slack assistant. Answer the user's request concisely and accurately.",
        model,
        modelSettings: {
          store: this.storeResponses,
          ...(request.effort ? { reasoning: { effort: request.effort } } : {}),
        },
        tools: [...providerTools, ...actionTools, ...subagentTools],
        // Pre-constructed servers are provider-specific by contract; core only
        // models their lifecycle, so widen them back for the SDK here.
        mcpServers: [
          ...mcpBundle.servers,
          ...(configuredMcpServers as MCPServer[]),
        ],
      });
    } catch (error) {
      await mcpBundle.close();
      yield {
        type: "terminal",
        outcome: "failed",
        reason: error instanceof Error ? error.message : String(error),
      } as const;
      return;
    }

    const previousResponseId =
      this.sessionMode === "previous_response_id" &&
      request.session.providerState.openai?.provider === "openai"
        ? request.session.providerState.openai.previousResponseId
        : undefined;
    let sdkSession: Session | undefined;
    if (this.sessionMode === "sdk_session") {
      const state = request.session.providerState.openai;
      if (state?.provider !== "openai" || state.mode !== "sdk_session") {
        await this.deleteSdkSession(request.metadata.sessionKey);
      }
      sdkSession = this.sdkSessions.get(request.metadata.sessionKey);
      if (sdkSession) {
        this.sdkSessions.delete(request.metadata.sessionKey);
        this.sdkSessions.set(request.metadata.sessionKey, sdkSession);
      } else {
        if (this.sdkSessions.size >= this.maxSdkSessions) {
          const oldestKey = this.sdkSessions.keys().next().value;
          if (oldestKey !== undefined) await this.deleteSdkSession(oldestKey);
        }
        sdkSession = new MemorySession({
          sessionId: request.metadata.sessionKey,
        });
        this.sdkSessions.set(request.metadata.sessionKey, sdkSession);
      }
    }

    try {
      await this.connectMcpServers(
        [...mcpBundle.servers, ...configuredMcpServers],
        request.signal,
      );
    } catch (error) {
      // Both server sets must be released here: this path returns before the
      // finally block below, so anything that did connect would otherwise leak.
      await this.closeMcpServers(mcpBundle, configuredMcpServers);
      if (request.signal.aborted) {
        yield {
          type: "terminal",
          outcome: "cancelled",
          reason: "aborted",
        } as const;
        return;
      }
      yield {
        type: "terminal",
        outcome: "failed",
        reason: error instanceof Error ? error.message : String(error),
      } as const;
      return;
    }

    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const stream = await this.runner.run(agent, request.prompt, {
            stream: true,
            signal: request.signal,
            maxTurns: request.maxTurns,
            ...(previousResponseId && { previousResponseId }),
            ...(sdkSession && { session: sdkSession }),
          });
          for await (const event of adaptOpenAIStream(stream, {
            signal: request.signal,
            sessionMode: this.sessionMode,
            sessionKey: request.metadata.sessionKey,
            result: stream,
          })) {
            if (event.type === "session_update") {
              request.session.providerState.openai = event.state;
            }
            yield event;
          }
          return;
        } catch (error) {
          if (
            attempt === 0 &&
            !request.signal.aborted &&
            (error as any)?.name !== "AbortError" &&
            isTransientPreRunFailure(error)
          ) {
            continue;
          }
          if (request.signal.aborted || (error as any)?.name === "AbortError") {
            yield {
              type: "terminal",
              outcome: "cancelled",
              reason: "aborted",
            } as const;
          } else if (
            (error as any)?.name === "MaxTurnsExceededError" ||
            /max.?turns/i.test(
              error instanceof Error ? error.message : String(error),
            )
          ) {
            yield {
              type: "terminal",
              outcome: "limit",
              reason: "max_turns",
            } as const;
          } else {
            yield {
              type: "terminal",
              outcome: "failed",
              reason: error instanceof Error ? error.message : String(error),
            } as const;
          }
          return;
        }
      }
    } finally {
      await this.closeMcpServers(mcpBundle, configuredMcpServers);
    }
  }

  private async deleteSdkSession(sessionKey: string): Promise<void> {
    const session = this.sdkSessions.get(sessionKey);
    this.sdkSessions.delete(sessionKey);
    if (session) await session.clearSession();
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.sdkSessions.values()].map(session => session.clearSession()),
    );
    this.sdkSessions.clear();
    await this.providerClient.close();
  }
}
