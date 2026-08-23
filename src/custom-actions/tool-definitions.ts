import type { ToolIdentity } from "../agent/events";

/**
 * Provider-neutral result returned by an application-owned custom action.
 *
 * The Slack approval workflow is intentionally kept in the registry. Runtime
 * adapters only need the text and these structured lifecycle flags; they must
 * not infer approval state from provider-specific wording.
 */
export interface ActionToolResult {
  text?: string;
  suppressReply?: boolean;
  confirmationDialogPosted?: boolean;
  isError?: boolean;
}

/** A custom action exposed as a function/MCP tool by a provider adapter. */
export interface ActionToolDefinition {
  identity: ToolIdentity;
  name: string;
  description: string;
  /** Existing actions use a raw JSON-schema shape for both SDK adapters. */
  inputSchema: Record<string, any>;
  requiresApproval: boolean;
  invoke(args: unknown): Promise<ActionToolResult>;
}
