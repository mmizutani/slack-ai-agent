import { AgentRunRequest } from "../../agent/events";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentRuntime } from "../../agent/runtime";
import { ConversationSession } from "../../types";
import { ClaudeHandler } from "../../claude-handler";
import { AllowedModel, RequestMode } from "../../request-mode";
import { adaptAnthropicStream } from "./event-adapter";

export class ClaudeAgentRuntime implements AgentRuntime {
  readonly provider = "anthropic" as const;

  constructor(
    private readonly handler: Pick<ClaudeHandler, "streamQuery">,
  ) {}

  async *stream(request: AgentRunRequest) {
    if (request.signal.aborted) {
      yield { type: "terminal", outcome: "cancelled", reason: "aborted" } as const;
      return;
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });

    const requestMode: RequestMode = {
      model: request.model.model as AllowedModel,
      effort: request.effort as RequestMode["effort"],
      fast: request.fast,
    };

    try {
      yield* adaptAnthropicStream(
        this.handler.streamQuery(
          request.prompt,
          request.session as ConversationSession,
          controller,
          request.slackContext,
          () => {},
          request.systemPrompt,
          requestMode,
        ) as AsyncIterable<SDKMessage>,
        { signal: request.signal },
      );
    } finally {
      request.signal.removeEventListener("abort", abort);
    }
  }
}
