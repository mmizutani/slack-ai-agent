export type AgentErrorKind =
  | "configuration"
  | "authentication"
  | "rate_limit"
  | "provider_unavailable"
  | "max_turns"
  | "budget_limit"
  | "tool_error"
  | "permission_denied"
  | "cancelled"
  | "invalid_response"
  | "unknown";

export class AgentConfigurationError extends Error {
  readonly kind = "configuration" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
    this.name = "AgentConfigurationError";
  }
}
