import type { HarnessConfig } from "./config";
import type { FixtureSet } from "./fixtures";
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
  /**
   * Requests the failing endpoint received, for cycles that use one. Lets a
   * cycle distinguish "the provider failed as intended" from "the base URL
   * override never took effect", which otherwise look identical: silence.
   */
  fakeProviderHits?(): number;
  /** Fixture configuration installed for this run, for the tool cycles. */
  fixtures?: FixtureSet;
}

export type CycleOutcome = void | { gap?: string; evidence?: string };

/**
 * Host variants a cycle can require.
 *
 * - `default`      fixture MCP server and workspace file, no custom actions
 * - `actions`      as default, plus the approval-gated fixture action
 * - `failing-provider` provider base URL pointed at a local failing endpoint
 */
export type CycleProfile = "default" | "actions" | "failing-provider";

export const CYCLE_PROFILES: CycleProfile[] = [
  "default",
  "actions",
  "failing-provider",
];

export interface Cycle {
  id: string;
  /** One line, shown in the report. */
  describe: string;
  /**
   * Which host this cycle needs. Cycles sharing a profile share one process.
   *
   * Profiles exist to stop cycles interfering with each other. The fixture
   * custom action is registered with alwaysInject, so on a host that loads it
   * every turn is offered a "record a verification code" tool — and the model
   * will sometimes call it during an unrelated cycle, derailing that cycle
   * non-deterministically. Only the approval cycle gets that host.
   */
  profile?: CycleProfile;
  /**
   * Per-cycle reply budget. Only set it where the app is legitimately slower
   * than the default, so one slow path does not hide regressions in the rest.
   */
  timeoutMs?: number;
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
  fakeProviderHits?: () => number;
  fixtures?: FixtureSet;
  timeoutMs?: number;
}): CycleContext {
  const { config, host, provider, cycleId, track } = options;
  const defaultTimeoutMs = options.timeoutMs ?? config.cycleTimeoutMs;
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
      { timeoutMs: timeoutMs ?? defaultTimeoutMs },
    );

    if (!found) {
      throw new CycleFailure(
        `no matching bot reply in ${channel}/${rootTs} within ${timeoutMs ?? defaultTimeoutMs}ms`,
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
    ...(options.fakeProviderHits
      ? { fakeProviderHits: options.fakeProviderHits }
      : {}),
    ...(options.fixtures ? { fixtures: options.fixtures } : {}),
  };
}

/**
 * Remove every message a run created.
 *
 * Deletion uses whichever token authored the message: Slack only lets a token
 * delete its own messages. Failures are swallowed per message so one
 * already-deleted message cannot abort the rest of the cleanup.
 */
export interface CleanUpResult {
  removed: number;
  attempted: number;
  /** Messages still in Slack, with the reason each could not be removed. */
  residue: { channel: string; ts: string; reason: string }[];
}

export async function cleanUp(
  traces: readonly Trace[],
  bot: SlackApi,
  driver: SlackApi,
): Promise<CleanUpResult> {
  // The same message can be tracked more than once — a cycle may both await a
  // reply and re-read the thread — and a second delete would look like a
  // failure that is not one.
  const unique = new Map<string, Trace>();
  for (const trace of traces) unique.set(`${trace.channel}:${trace.ts}`, trace);

  const residue: CleanUpResult["residue"] = [];
  let removed = 0;
  for (const trace of [...unique.values()].reverse()) {
    try {
      await (trace.as === "bot" ? bot : driver).deleteMessage(
        trace.channel,
        trace.ts,
      );
      removed += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown";
      // message_not_found means it is already gone, which is the goal.
      if (/message_not_found/.test(reason)) {
        removed += 1;
        continue;
      }
      residue.push({ channel: trace.channel, ts: trace.ts, reason });
    }
  }
  return { removed, attempted: unique.size, residue };
}

/**
 * Tool calls the app recorded for the most recent turn in `logs`.
 *
 * `ConsoleEventHandler` reports a per-turn count on its "Message processed"
 * event. Shared by every cycle that claims a tool ran, so the two tool cycles
 * cannot assert it differently — one of them originally checked only that the
 * expected string came back, which the model could in principle produce
 * without calling anything.
 *
 * Returns undefined when no turn has been recorded yet, which is a different
 * answer from zero and must not be conflated with it.
 */
export function recordedToolCalls(logs: string): number | undefined {
  const matches = [...logs.matchAll(/"toolCalls":(\d+)/g)];
  const last = matches[matches.length - 1];
  return last ? Number(last[1]) : undefined;
}
