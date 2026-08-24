import type { HarnessConfig } from "./config";
import type { AgentHost } from "./host";
import type { ProviderId } from "./report";
import { markerFor } from "./markers";
import {
  isBotMessage,
  pollUntil,
  type SlackMessage,
  type SlackApi,
} from "./slack";

/** A message this run created, so teardown can remove it. */
export interface Trace {
  channel: string;
  ts: string;
  as: "bot" | "user";
}

export interface AwaitReplyOptions {
  channel: string;
  /** Thread root to watch. The bot replies under event.thread_ts || event.ts. */
  rootTs: string;
  /** Ignore replies that do not satisfy this. */
  match?: (message: SlackMessage) => boolean;
  timeoutMs?: number;
}

export interface CycleContext {
  config: HarnessConfig;
  host: AgentHost;
  provider: ProviderId;
  /** Marker unique to this run and cycle. */
  marker(suffix?: string): string;
  /**
   * Post as the driver and remember the message for teardown.
   *
   * The bot is @-mentioned by default, and that is not cosmetic. The driver
   * token is a user token belonging to this same Slack app, so every message
   * it posts carries `bot_id` and `app_id` — Slack attributes it to the app,
   * and `as_user` does not change that. `isBotAuthoredMessage` therefore sees
   * a bot message, and SlackHandler deliberately ignores bot messages unless
   * they explicitly mention the bot. Without the mention a cycle simply gets
   * silence, which reads as a product bug rather than a harness artefact.
   *
   * Pass `mention: false` only when a cycle is specifically testing what
   * happens to an unmentioned message.
   */
  say(
    text: string,
    options?: { channel?: string; threadTs?: string; mention?: boolean },
  ): Promise<string>;
  /** Wait for a bot reply in a thread, remembering it for teardown. */
  awaitBotReply(options: AwaitReplyOptions): Promise<SlackMessage>;
  track(trace: Trace): void;
  /** Log output produced since the cycle started. */
  logsSinceStart(): string;
}

export type CycleOutcome = void | { gap?: string; evidence?: string };

export interface Cycle {
  id: string;
  /** One line, shown in the report. */
  describe: string;
  run(ctx: CycleContext): Promise<CycleOutcome>;
}

export class CycleFailure extends Error {}

/** Assert, with a message that says what was expected and what happened. */
export function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CycleFailure(message);
}

/**
 * Build the per-cycle context.
 *
 * Every message the cycle sends is recorded as it is sent, not at the end, so
 * a cycle that throws half way still has its messages cleaned up.
 */
export function makeContext(options: {
  config: HarnessConfig;
  host: AgentHost;
  provider: ProviderId;
  cycleId: string;
  track: (trace: Trace) => void;
}): CycleContext {
  const { config, host, provider, cycleId, track } = options;
  const startMark = host.mark();

  const awaitBotReply = async ({
    channel,
    rootTs,
    match,
    timeoutMs,
  }: AwaitReplyOptions): Promise<SlackMessage> => {
    const found = await pollUntil(
      async () => {
        const messages = await config.bot.replies(channel, rootTs);
        return messages.find(
          message =>
            message.ts !== rootTs &&
            isBotMessage(message, config.botUserId) &&
            (match ? match(message) : true),
        );
      },
      { timeoutMs: timeoutMs ?? config.cycleTimeoutMs },
    );

    if (!found) {
      throw new CycleFailure(
        `no matching bot reply in ${channel}/${rootTs} within ${timeoutMs ?? config.cycleTimeoutMs}ms`,
      );
    }
    track({ channel, ts: found.ts, as: "bot" });
    return found;
  };

  return {
    config,
    host,
    provider,
    marker: (suffix?: string) =>
      markerFor(config.runId, suffix ? `${cycleId}-${suffix}` : cycleId),
    say: async (text, opts) => {
      const channel = opts?.channel ?? config.channelId;
      const body =
        opts?.mention === false ? text : `<@${config.botUserId}> ${text}`;
      const ts = await config.driver.postMessage(channel, body, opts?.threadTs);
      track({ channel, ts, as: "user" });
      return ts;
    },
    awaitBotReply,
    track,
    logsSinceStart: () => host.logsSince(startMark),
  };
}

/**
 * Remove every message a run created.
 *
 * Deletion uses whichever token authored the message: Slack only lets a token
 * delete its own messages. Failures are swallowed per message so one
 * already-deleted message cannot abort the rest of the cleanup.
 */
export async function cleanUp(
  traces: readonly Trace[],
  bot: SlackApi,
  driver: SlackApi,
): Promise<number> {
  let removed = 0;
  for (const trace of [...traces].reverse()) {
    try {
      await (trace.as === "bot" ? bot : driver).deleteMessage(
        trace.channel,
        trace.ts,
      );
      removed += 1;
    } catch {
      // Already gone, or never posted. Nothing to do.
    }
  }
  return removed;
}
