import { AgentProviderId } from "../types";

export type { AgentProviderId } from "../types";

export type EffortLevel =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface ModelRef {
  provider: AgentProviderId;
  model: string;
}

export interface ModelCapabilities {
  reasoningEfforts: ReadonlySet<EffortLevel>;
  supportsFastMode: boolean;
  supportsStreaming: boolean;
  supportsMcp: boolean;
  supportsSubagents: boolean;
  supportsWorkspaceRead: boolean;
  supportsWorkspaceWrite: boolean;
  supportsShell: boolean;
}

export function parseModelRef(value: string): ModelRef {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Model reference must not be empty");

  const separator = trimmed.indexOf("/");
  if (separator === -1) {
    return { provider: "anthropic", model: trimmed };
  }

  const provider = trimmed.slice(0, separator);
  const model = trimmed.slice(separator + 1);
  if ((provider !== "anthropic" && provider !== "openai") || !model) {
    throw new Error(`Invalid model reference: ${value}`);
  }
  return { provider, model };
}

/**
 * Parse a model reference from operator-editable configuration. Returns
 * undefined instead of throwing so a malformed value can fail open to the
 * deployment default rather than aborting the turn that read it.
 */
export function tryParseModelRef(value: string): ModelRef | undefined {
  try {
    return parseModelRef(value);
  } catch {
    return undefined;
  }
}

export function formatModelRef(model: ModelRef): string {
  return `${model.provider}/${model.model}`;
}
