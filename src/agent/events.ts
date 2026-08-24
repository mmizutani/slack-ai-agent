import {
  AgentProviderId,
  PhaseTimings,
  ProviderSessionState,
  SlackContext,
} from "../types";

export interface ToolIdentity {
  kind: "mcp" | "workspace" | "action" | "provider_native";
  server?: string;
  name: string;
}

export interface AgentUsage {
  requests?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
}

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "text_complete"; text: string }
  | {
      type: "tool_call";
      callId?: string;
      tool: ToolIdentity;
      arguments?: unknown;
      sideEffecting: boolean;
    }
  | {
      type: "tool_result";
      callId?: string;
      tool?: ToolIdentity;
      output?: unknown;
      isError?: boolean;
      suppressReply?: boolean;
      confirmationDialogPosted?: boolean;
    }
  | { type: "session_update"; state: ProviderSessionState }
  | { type: "usage"; usage: AgentUsage }
  | { type: "warning"; code: string; message: string }
  | {
      type: "terminal";
      outcome: "completed" | "cancelled" | "limit" | "failed";
      finalText?: string;
      reason?: string;
      turnCount?: number;
      usage?: AgentUsage;
      costUsd?: number;
    };

export type RuntimeSessionState = ProviderSessionState;

export interface EffectiveToolPolicy {
  role?: string;
  allowed?: readonly string[];
  denied?: readonly string[];
}

/**
 * The policy a runtime receives when the producer could not resolve one. An
 * absent policy must read as "nothing is permitted", never as "unrestricted".
 */
export const DENY_ALL_TOOL_POLICY: EffectiveToolPolicy = Object.freeze({
  role: "none",
  allowed: Object.freeze([]) as readonly string[],
  denied: Object.freeze([]) as readonly string[],
});

/**
 * A pre-constructed, provider-specific MCP server handed to a runtime ready to
 * use. Core only ever drives its lifecycle, so the shape stays structural
 * rather than importing a provider SDK type.
 */
export interface RuntimeMcpServerHandle {
  connect?(): Promise<void>;
  close?(): Promise<void>;
}

/**
 * Request-scoped tools built before SDK construction and handed to a runtime.
 *
 * The fields are declared rather than left to an index signature so the
 * producer and every runtime consumer are checked against the same contract: a
 * misspelled field is a compile error, and consumers no longer cast each value
 * back from `unknown`.
 */
export interface RuntimeToolBundle {
  workspaceTools?: readonly import("../workspace/tools").WorkspaceToolDefinition[];
  actionDefinitions?: readonly import("../custom-actions/tool-definitions").ActionToolDefinition[];
  mcpDefinitions?: readonly import("../mcp/types").ResolvedMcpServerDefinition[];
  subagentDefinitions?: readonly import("../subagents/types").SubagentDefinition[];
  mcpServers?: readonly RuntimeMcpServerHandle[];
  permissionPolicy?: EffectiveToolPolicy;
}

export interface AgentRunRequest {
  prompt: string;
  systemPrompt?: string;
  session: import("../types").ConversationSession;
  slackContext?: SlackContext;
  model: { provider: AgentProviderId; model: string };
  effort?: import("./model").EffortLevel;
  fast?: boolean;
  signal: AbortSignal;
  maxTurns: number;
  permissions: EffectiveToolPolicy;
  tools: RuntimeToolBundle;
  metadata: {
    requestId: string;
    sessionKey: string;
  };
  phaseTimings?: PhaseTimings;
}
