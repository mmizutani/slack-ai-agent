import {
  AgentEvent,
  AgentRunRequest,
  DENY_ALL_TOOL_POLICY,
  RuntimeToolBundle,
} from "./agent/events";
import { AgentRuntime } from "./agent/runtime";
import { AgentRuntimeRegistry } from "./runtimes/registry";
import { ModelRef } from "./agent/model";
import { RequestMode } from "./request-mode";
import {
  ConversationSession,
  SlackContext,
  TokenUsage,
  PhaseTimings,
} from "./types";
import { Logger, truncateForLog } from "./logger";
import { ReactionManager, REACTIONS } from "./reaction-manager";
import { ChannelConfigManager } from "./channel-config";
import {
  TOOL_CALL_PARAM_LOG_MAX_LENGTH,
  TOOL_RESPONSE_LOG_MAX_LENGTH,
} from "./constants";

export interface MessageProcessorResult {
  messages: string[];
  shouldNotRespond: boolean;
  failed?: boolean;
  doNotRespondOptOut?: boolean;
  debugLogs?: string[];
  toolCalls?: string[];
  toolCallNames?: string[];
  confirmationDialogPosted?: boolean;
  tokenUsage?: TokenUsage;
  turnCount?: number;
  costUsd?: number;
  phaseTimings?: PhaseTimings;
  provider?: "anthropic" | "openai";
  model?: string;
}

export const GENERIC_FAILURE_MESSAGE =
  "❌ Something went wrong while processing your request. Please try again.";

const CUSTOM_ACTION_SUPPRESSES_REPLY =
  /confirmation dialog has been posted|Do not send any additional text response to the user/i;

export class MessageProcessor {
  private logger = new Logger("MessageProcessor");
  private runtimeRegistry: AgentRuntimeRegistry;
  private reactionManager: ReactionManager;
  private channelConfig: ChannelConfigManager;

  constructor(
    runtimeRegistry: AgentRuntimeRegistry,
    reactionManager: ReactionManager,
    channelConfig: ChannelConfigManager,
  ) {
    this.runtimeRegistry = runtimeRegistry;
    this.reactionManager = reactionManager;
    this.channelConfig = channelConfig;
  }

  private logSensitive(
    message: string,
    safeData: Record<string, unknown>,
    sensitiveContent: string,
    allowFullLogging: boolean,
    isDebugMode?: boolean,
    debugLogs?: string[],
  ): void {
    this.logger.infoSensitive(
      message,
      safeData,
      sensitiveContent,
      allowFullLogging,
    );
    if (isDebugMode && debugLogs) {
      const safeStr =
        Object.keys(safeData).length > 0 ? ` ${JSON.stringify(safeData)}` : "";
      debugLogs.push(`${message} ${sensitiveContent}${safeStr}`);
    }
  }

  private async shouldHonorDoNotRespond(
    slackContext: SlackContext,
  ): Promise<boolean> {
    if (slackContext.smartReply) return true;
    return this.channelConfig.isConditionalReplyChannel(
      slackContext.channel,
      slackContext.channelType,
    );
  }

  private async shouldShowReactions(
    slackContext: SlackContext,
  ): Promise<boolean> {
    if (slackContext.smartReply) return false;
    const isEphemeralChannel =
      await this.channelConfig.shouldUseEphemeralMessaging(
        slackContext.channel,
      );
    const willBeEphemeral =
      isEphemeralChannel &&
      !slackContext.explicitMention &&
      (await this.channelConfig.getEphemeralTargetUsers(slackContext.channel))
        .length > 0;
    return !willBeEphemeral;
  }

  /** Consume only normalized AgentEvent values from any provider runtime. */
  async processAgentStream(
    prompt: string,
    session: ConversationSession,
    abortController: AbortController,
    runtime: AgentRuntime,
    slackContext?: SlackContext,
    sessionKey?: string,
    systemPrompt?: string,
    allowFullLogging?: boolean,
    requestMode?: RequestMode,
    runtimeTools: RuntimeToolBundle = {},
  ): Promise<MessageProcessorResult> {
    const currentMessages: string[] = [];
    const debugLogs: string[] = [];
    const toolCalls: string[] = [];
    const toolCallNames: string[] = [];
    let confirmationDialogPosted = false;
    let shouldNotRespond = false;
    let doNotRespondOptOut = false;
    let tokenUsage: TokenUsage | undefined;
    let costUsd: number | undefined;
    let turnCount = 0;
    let finalText = "";
    let terminalOutcome: Extract<AgentEvent, { type: "terminal" }> | undefined;
    let failed = false;
    const timings: PhaseTimings = {};
    const isDebugMode = prompt.includes("[DEBUG]");
    const requestedModel =
      typeof requestMode?.model === "string"
        ? requestMode.model
        : requestMode?.model?.model;
    const model: ModelRef = {
      provider:
        typeof requestMode?.model === "object"
          ? requestMode.model.provider
          : runtime.provider,
      model: requestedModel ?? "",
    };

    this.logger.info("📝 Starting query", {
      promptLen: prompt.length,
      resuming: !!session.providerState[runtime.provider],
      provider: runtime.provider,
      model: model.model || "default",
      isDebugMode: isDebugMode ? "true" : "false",
    });

    const reactionStart = Date.now();
    if (
      sessionKey &&
      slackContext &&
      (await this.shouldShowReactions(slackContext))
    ) {
      await this.reactionManager.updateReaction(sessionKey, REACTIONS.THINKING);
    }
    timings.initial_reaction_ms = Date.now() - reactionStart;

    const streamStart = Date.now();
    let firstMessageReceived = false;
    const request: AgentRunRequest = {
      prompt,
      systemPrompt,
      session,
      slackContext,
      model,
      effort: requestMode?.effort,
      fast: requestMode?.fast,
      signal: abortController.signal,
      maxTurns: 400,
      // A missing policy is deny-by-default, not unrestricted.
      permissions:
        runtimeTools.permissionPolicy &&
        typeof runtimeTools.permissionPolicy === "object"
          ? (runtimeTools.permissionPolicy as AgentRunRequest["permissions"])
          : DENY_ALL_TOOL_POLICY,
      tools: runtimeTools,
      metadata: {
        requestId: `${sessionKey ?? "session"}:${Date.now()}`,
        sessionKey: sessionKey ?? `${session.userId}-${session.channelId}`,
      },
    };

    for await (const event of runtime.stream(request)) {
      if (!firstMessageReceived) {
        timings.agent_time_to_first_message_ms = Date.now() - streamStart;
        firstMessageReceived = true;
      }

      if (event.type === "text_delta" || event.type === "text_complete") {
        finalText += event.text;
        if (
          /DO_NOT_RESPOND/i.test(finalText) &&
          slackContext &&
          (await this.shouldHonorDoNotRespond(slackContext))
        ) {
          shouldNotRespond = true;
          doNotRespondOptOut = true;
        }
        continue;
      }

      if (event.type === "tool_call") {
        turnCount++;
        const name = event.tool.server
          ? `${event.tool.server}/${event.tool.name}`
          : event.tool.name;
        const safeName =
          name === "Skill" &&
          typeof (event.arguments as any)?.skill === "string"
            ? `Skill:${(event.arguments as any).skill}`
            : name;
        const params = Object.entries(
          (event.arguments as Record<string, unknown>) ?? {},
        )
          .map(([key, value]) => {
            const rendered =
              typeof value === "string" ? value : JSON.stringify(value);
            return `${key}=${truncateForLog(rendered, TOOL_CALL_PARAM_LOG_MAX_LENGTH)}`;
          })
          .join(", ");
        const formatted = params ? `${name}(${params})` : `${name}()`;
        this.logSensitive(
          "🔧",
          { tools: [safeName] },
          formatted,
          allowFullLogging ?? false,
          isDebugMode,
          debugLogs,
        );
        toolCalls.push(formatted);
        toolCallNames.push(safeName);
        if (
          sessionKey &&
          slackContext &&
          (await this.shouldShowReactions(slackContext))
        ) {
          await this.reactionManager.updateReaction(
            sessionKey,
            REACTIONS.TOOL_USE,
          );
        }
        continue;
      }

      if (event.type === "tool_result") {
        const output =
          typeof event.output === "string"
            ? event.output
            : JSON.stringify(event.output ?? "");
        this.logSensitive(
          `📋 Result (${output.length} chars):`,
          {},
          truncateForLog(output, TOOL_RESPONSE_LOG_MAX_LENGTH),
          allowFullLogging ?? false,
          isDebugMode,
          debugLogs,
        );
        if (
          event.suppressReply ||
          event.confirmationDialogPosted ||
          CUSTOM_ACTION_SUPPRESSES_REPLY.test(output)
        ) {
          shouldNotRespond = true;
        }
        if (event.confirmationDialogPosted) confirmationDialogPosted = true;
        continue;
      }

      if (event.type === "session_update") {
        session.providerState[event.state.provider] = event.state;
        if (event.state.provider === "anthropic" && event.state.sessionId) {
          session.sessionId = event.state.sessionId;
        }
        continue;
      }

      if (event.type === "usage") {
        tokenUsage = {
          inputTokens: event.usage.inputTokens ?? 0,
          outputTokens: event.usage.outputTokens ?? 0,
          cacheReadInputTokens: event.usage.cachedInputTokens,
          cacheCreationInputTokens: event.usage.cacheWriteTokens,
        };
        continue;
      }

      if (event.type === "terminal") {
        terminalOutcome = event;
        if (event.outcome === "failed") {
          failed = true;
        }
        if (event.turnCount !== undefined) turnCount = event.turnCount;
        if (event.usage) {
          tokenUsage = {
            inputTokens: event.usage.inputTokens ?? 0,
            outputTokens: event.usage.outputTokens ?? 0,
            cacheReadInputTokens: event.usage.cachedInputTokens,
            cacheCreationInputTokens: event.usage.cacheWriteTokens,
          };
        }
        if (event.costUsd !== undefined) costUsd = event.costUsd;
        if (event.finalText) finalText = event.finalText;
        if (
          /DO_NOT_RESPOND/i.test(finalText) &&
          slackContext &&
          (await this.shouldHonorDoNotRespond(slackContext))
        ) {
          shouldNotRespond = true;
          doNotRespondOptOut = true;
        }
      }
    }

    if (failed) {
      if (confirmationDialogPosted) {
        shouldNotRespond = true;
      } else {
        shouldNotRespond = false;
        doNotRespondOptOut = false;
        currentMessages.push(GENERIC_FAILURE_MESSAGE);
      }
    } else if (currentMessages.length === 0) {
      if (terminalOutcome?.outcome === "limit" && !finalText.trim()) {
        currentMessages.push(
          /budget/i.test(terminalOutcome.reason ?? "")
            ? "I hit the per-request spending limit before finishing. Please try a narrower request or ask a human to raise the cap."
            : "I ran out of turns before finishing this task. Please try a narrower request or ask a human to raise the cap.",
        );
      } else if (finalText) {
        currentMessages.push(finalText);
      }
    }

    timings.agent_total_stream_ms = Date.now() - streamStart;
    if (runtime.provider === "anthropic") {
      timings.claude_time_to_first_message_ms =
        timings.agent_time_to_first_message_ms ?? 0;
      timings.claude_total_stream_ms = timings.agent_total_stream_ms;
    }

    this.logger.info("✅ Completed", {
      provider: runtime.provider,
      msgs: currentMessages.length,
      tools: toolCalls.length,
      turns: turnCount,
      ...(tokenUsage
        ? {
            inputTokens: tokenUsage.inputTokens,
            outputTokens: tokenUsage.outputTokens,
          }
        : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    });

    return {
      messages: currentMessages,
      shouldNotRespond,
      failed: failed || undefined,
      doNotRespondOptOut: doNotRespondOptOut || undefined,
      debugLogs: isDebugMode ? debugLogs : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      toolCallNames: toolCallNames.length > 0 ? toolCallNames : undefined,
      confirmationDialogPosted: confirmationDialogPosted || undefined,
      tokenUsage,
      costUsd,
      turnCount: turnCount > 0 ? turnCount : undefined,
      phaseTimings: timings,
      provider: runtime.provider,
      model: model.model || undefined,
    };
  }

  /** Compatibility wrapper retained while callers migrate to processAgentStream. */
  async processClaudeStream(
    prompt: string,
    session: ConversationSession,
    abortController: AbortController,
    slackContext?: SlackContext,
    sessionKey?: string,
    systemPrompt?: string,
    allowFullLogging?: boolean,
    requestMode?: RequestMode,
    runtimeTools: RuntimeToolBundle = {},
  ): Promise<MessageProcessorResult> {
    return this.processAgentStream(
      prompt,
      session,
      abortController,
      this.runtimeRegistry.get("anthropic"),
      slackContext,
      sessionKey,
      systemPrompt,
      allowFullLogging,
      requestMode,
      runtimeTools,
    );
  }
}
