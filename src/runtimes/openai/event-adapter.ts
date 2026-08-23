import type { AgentEvent, AgentUsage, ToolIdentity } from "../../agent/events";

export interface OpenAIStreamResultLike {
  finalOutput?: unknown;
  currentTurn?: number;
  cancelled?: boolean;
  error?: unknown;
  completed?: Promise<void>;
}

export interface OpenAIEventAdapterOptions {
  signal?: AbortSignal;
  sessionMode?: "previous_response_id" | "sdk_session";
  sessionKey?: string;
  result?: OpenAIStreamResultLike;
  settlementTimeoutMs?: number;
}

const DEFAULT_SETTLEMENT_TIMEOUT_MS = 5_000;

async function awaitSettlement(
  completed: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      completed,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("OpenAI stream settlement timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function toolIdentity(name: string): ToolIdentity {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return { kind: "mcp", server: mcp[1], name: mcp[2] };
  const action = /^action[:/]([^/]+)\/(.+)$/.exec(name);
  if (action) return { kind: "action", server: action[1], name: action[2] };
  const namespacedAction = /^action__(.+?)__(.+)$/.exec(name);
  if (namespacedAction) {
    return {
      kind: "action",
      server: namespacedAction[1],
      name: namespacedAction[2],
    };
  }
  return { kind: "provider_native", name };
}

function sideEffecting(name: string): boolean {
  return !/^(read|search|lookup|list|get|describe|glob|grep|fetch|websearch)/i.test(
    name,
  );
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function textOutput(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value
      .map(item =>
        typeof item === "string"
          ? item
          : typeof (item as any)?.text === "string"
            ? (item as any).text
            : "",
      )
      .join("");
    return text || undefined;
  }
  return value === undefined ? undefined : JSON.stringify(value);
}

function usageFrom(value: any): AgentUsage | undefined {
  if (!value) return undefined;
  const inputTokens = value.inputTokens ?? value.input_tokens;
  const outputTokens = value.outputTokens ?? value.output_tokens;
  const totalTokens = value.totalTokens ?? value.total_tokens;
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  return {
    requests: value.requests ?? 1,
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
  };
}

function isMaxTurns(error: unknown): boolean {
  return (
    (error as any)?.name === "MaxTurnsExceededError" ||
    /max.?turns/i.test(error instanceof Error ? error.message : String(error))
  );
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error as any)?.name === "AbortError";
}

function structuredFlags(output: unknown): {
  suppressReply?: boolean;
  confirmationDialogPosted?: boolean;
  isError?: boolean;
} {
  let value: Record<string, unknown> | undefined;
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      if (parsed && typeof parsed === "object") value = parsed;
    } catch {
      return {};
    }
  } else if (output && typeof output === "object") {
    value = output as Record<string, unknown>;
  }
  if (!value) return {};
  return {
    ...(value.suppressReply === true && { suppressReply: true }),
    ...(value.confirmationDialogPosted === true && {
      confirmationDialogPosted: true,
    }),
    ...(value.isError === true && { isError: true }),
  };
}

function eventData(event: any): any {
  return event?.type === "raw_model_stream_event" ? event.data : undefined;
}

/** Normalize the installed Agents SDK 0.17 stream event surface. */
export async function* adaptOpenAIStream(
  stream: AsyncIterable<unknown>,
  options: OpenAIEventAdapterOptions = {},
): AsyncGenerator<AgentEvent> {
  let terminalEmitted = false;
  let latestResponseId: string | undefined;
  let latestUsage: AgentUsage | undefined;
  const result = options.result;

  const emitTerminal = (
    event: Extract<AgentEvent, { type: "terminal" }>,
  ): AgentEvent | undefined => {
    if (terminalEmitted) return undefined;
    terminalEmitted = true;
    return event;
  };

  if (options.signal?.aborted) {
    yield { type: "terminal", outcome: "cancelled", reason: "aborted" };
    return;
  }

  try {
    for await (const event of stream) {
      if (options.signal?.aborted) break;
      const sdkEvent = event as any;
      const raw = eventData(sdkEvent);
      if (raw?.type === "output_text_delta" && raw.delta) {
        yield { type: "text_delta", text: raw.delta };
        continue;
      }
      if (raw?.type === "response_done") {
        latestResponseId = raw.response?.id ?? latestResponseId;
        const usage = usageFrom(raw.response?.usage);
        if (usage) {
          latestUsage = usage;
          yield { type: "usage", usage };
        }
        if (options.sessionMode === "sdk_session" || latestResponseId) {
          yield {
            type: "session_update",
            state:
              options.sessionMode === "sdk_session"
                ? {
                    provider: "openai",
                    mode: "sdk_session",
                    ...(options.sessionKey && { sessionKey: options.sessionKey }),
                  }
                : {
                    provider: "openai",
                    mode: "previous_response_id",
                    previousResponseId: latestResponseId!,
                  },
          };
        }
        continue;
      }

      if (sdkEvent?.type !== "run_item_stream_event") continue;
      const rawItem = sdkEvent.item?.rawItem ?? sdkEvent.item;
      if (sdkEvent.name === "tool_called" && rawItem?.type === "function_call") {
        const name = rawItem.name ?? "unknown";
        const tool = toolIdentity(name);
        yield {
          type: "tool_call",
          callId: rawItem.callId,
          tool,
          arguments: parseArguments(rawItem.arguments),
          sideEffecting: sideEffecting(tool.name),
        };
        continue;
      }
      if (
        sdkEvent.name === "tool_output" &&
        rawItem?.type === "function_call_result"
      ) {
        const name = rawItem.name ?? "unknown";
        const output = rawItem.output;
        yield {
          type: "tool_result",
          callId: rawItem.callId,
          tool: toolIdentity(name),
          output,
          ...structuredFlags(output),
        };
      }
    }

    if (result?.completed) {
      await awaitSettlement(
        result.completed,
        options.settlementTimeoutMs ?? DEFAULT_SETTLEMENT_TIMEOUT_MS,
      );
    }
  } catch (error) {
    const terminal = emitTerminal(
      isAbort(error, options.signal)
        ? { type: "terminal", outcome: "cancelled", reason: "aborted" }
        : isMaxTurns(error)
          ? { type: "terminal", outcome: "limit", reason: "max_turns" }
          : {
              type: "terminal",
              outcome: "failed",
              reason: error instanceof Error ? error.message : String(error),
            },
    );
    if (terminal) yield terminal;
    return;
  }

  const error = result?.error;
  const terminal = emitTerminal(
    options.signal?.aborted || result?.cancelled
      ? { type: "terminal", outcome: "cancelled", reason: "aborted" }
      : error && isMaxTurns(error)
        ? { type: "terminal", outcome: "limit", reason: "max_turns" }
        : error
          ? {
              type: "terminal",
              outcome: "failed",
              reason: error instanceof Error ? error.message : String(error),
            }
          : {
              type: "terminal",
              outcome: "completed",
              ...(typeof result?.finalOutput === "string" && {
                finalText: result.finalOutput,
              }),
              ...(result?.currentTurn !== undefined && {
                turnCount: result.currentTurn,
              }),
              ...(latestUsage && { usage: latestUsage }),
            },
  );
  if (terminal) yield terminal;
}
