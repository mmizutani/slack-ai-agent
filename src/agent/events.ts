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

export interface RuntimeToolBundle {
  [name: string]: unknown;
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
