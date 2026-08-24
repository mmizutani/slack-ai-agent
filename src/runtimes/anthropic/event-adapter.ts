import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentEvent, AgentUsage, ToolIdentity } from "../../agent/events";

const SUPPRESS_REPLY =
  /confirmation dialog has been posted|Do not send any additional text response to the user/i;

function toolIdentity(name: string): ToolIdentity {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  if (match) {
    return { kind: "mcp", server: match[1], name: match[2] };
  }
  return { kind: "provider_native", name };
}

function isSideEffecting(name: string): boolean {
  return !/^(Read|Grep|Glob|LS|Search|WebSearch|ToolSearch)$/i.test(name);
}

function blockText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map(item =>
        typeof item === "string"
          ? item
          : ((item as any)?.text ?? JSON.stringify(item)),
      )
      .join("");
  }
  return JSON.stringify(value ?? "");
}

/**
 * Lifecycle flags set by the in-process custom-action MCP server (see
 * action-adapter). The SDK exposes the tool's full Output object on the user
 * message as `tool_use_result` — the nested `tool_result` block carries only
 * the model-visible text, so `structuredContent` never appears there.
 */
function lifecycleFlags(toolUseResult: unknown): {
  suppressReply?: boolean;
  confirmationDialogPosted?: boolean;
} {
  if (!toolUseResult || typeof toolUseResult !== "object") return {};
  const value = toolUseResult as Record<string, unknown>;
  const structured =
    value.structuredContent && typeof value.structuredContent === "object"
      ? (value.structuredContent as Record<string, unknown>)
      : value;
  return {
    ...(structured.suppressReply === true ? { suppressReply: true } : {}),
    ...(structured.confirmationDialogPosted === true
      ? { confirmationDialogPosted: true }
      : {}),
  };
}

function usageFromMessage(message: any): AgentUsage | undefined {
  const usage = message.usage ?? message.message?.usage;
  if (!usage) return undefined;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  return {
    requests: 1,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(usage.cache_read_input_tokens !== undefined
      ? { cachedInputTokens: usage.cache_read_input_tokens }
      : {}),
    ...(usage.cache_creation_input_tokens !== undefined
      ? { cacheWriteTokens: usage.cache_creation_input_tokens }
      : {}),
  };
}

export async function* adaptAnthropicStream(
  messages: AsyncIterable<SDKMessage> | Iterable<SDKMessage>,
  options: { signal?: AbortSignal } = {},
): AsyncGenerator<AgentEvent> {
  let terminalEmitted = false;
  let terminalUsage: AgentUsage | undefined;

  const terminal = (
    outcome: "completed" | "cancelled" | "limit" | "failed",
    details: Partial<Extract<AgentEvent, { type: "terminal" }>> = {},
  ): AgentEvent => ({ type: "terminal", outcome, ...details });

  try {
    for await (const message of messages) {
      if (options.signal?.aborted) break;

      if (message.type === "system" && message.subtype === "init") {
        yield {
          type: "session_update",
          state: { provider: "anthropic", sessionId: message.session_id },
        };
        continue;
      }

      if (message.type === "assistant") {
        for (const block of (message.message?.content ?? []) as any[]) {
          if (block.type === "text" && block.text) {
            yield { type: "text_delta", text: block.text };
          } else if (block.type === "tool_use" && block.name) {
            yield {
              type: "tool_call",
              callId: block.id,
              tool: toolIdentity(block.name),
              arguments: block.input,
              sideEffecting: isSideEffecting(block.name),
            };
          }
        }
        continue;
      }

      if (message.type === "user") {
        const structured = lifecycleFlags((message as any).tool_use_result);
        for (const block of ((message as any).message?.content ??
          (message as any).content ??
          []) as any[]) {
          if (block.type !== "tool_result") continue;
          const output = blockText(block.content);
          // Structured tool output is authoritative. Prose matching stays as a
          // fallback for tools that only signal these lifecycles in their text.
          const flags = {
            ...(SUPPRESS_REPLY.test(output) ? { suppressReply: true } : {}),
            ...(/confirmation dialog has been posted/i.test(output)
              ? { confirmationDialogPosted: true }
              : {}),
            ...structured,
          };
          yield {
            type: "tool_result",
            callId: block.tool_use_id,
            output,
            ...flags,
            ...(block.is_error ? { isError: true } : {}),
          };
        }
        continue;
      }

      if (message.type === "result") {
        terminalUsage = usageFromMessage(message);
        if (terminalUsage) yield { type: "usage", usage: terminalUsage };

        if (
          message.subtype === "error_max_budget_usd" ||
          message.subtype === "error_max_turns"
        ) {
          terminalEmitted = true;
          yield terminal("limit", {
            reason: message.subtype,
            usage: terminalUsage,
          });
          break;
        } else if (message.subtype === "success") {
          terminalEmitted = true;
          yield terminal("completed", {
            ...((message as any).result !== undefined
              ? { finalText: (message as any).result }
              : {}),
            ...(terminalUsage ? { usage: terminalUsage } : {}),
            ...((message as any).total_cost_usd !== undefined
              ? { costUsd: (message as any).total_cost_usd }
              : {}),
            ...((message as any).num_turns !== undefined
              ? { turnCount: (message as any).num_turns }
              : {}),
          });
          break;
        } else if (message.subtype === "error_during_execution") {
          terminalEmitted = true;
          yield terminal("failed", {
            reason: message.subtype,
            usage: terminalUsage,
            costUsd: (message as any).total_cost_usd,
          });
          break;
        } else {
          terminalEmitted = true;
          yield terminal("failed", {
            reason: message.subtype,
            usage: terminalUsage,
          });
          break;
        }
      }
    }
  } catch (error) {
    terminalEmitted = true;
    if (options.signal?.aborted || (error as any)?.name === "AbortError") {
      yield terminal("cancelled", { reason: "aborted", usage: terminalUsage });
    } else {
      yield terminal("failed", {
        reason: error instanceof Error ? error.message : String(error),
        usage: terminalUsage,
      });
    }
  }

  if (!terminalEmitted) {
    yield terminal(options.signal?.aborted ? "cancelled" : "completed", {
      reason: options.signal?.aborted ? "aborted" : undefined,
      usage: terminalUsage,
    });
  }
}
