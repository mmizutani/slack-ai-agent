/**
 * Minimal Slack Web API client for the live harness.
 *
 * Uses global fetch and form-encoded POSTs rather than @slack/web-api: that
 * package is only a transitive dependency here (via @slack/bolt), and the
 * harness must not start depending on another package's dependency tree.
 * Form encoding is used because every Slack method accepts it, while JSON
 * bodies are not universally supported on the older read methods.
 */

const SLACK_API = "https://slack.com/api";

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly slackError: string,
    readonly needed?: string,
  ) {
    // Deliberately excludes the request body: it can carry message text and
    // must never reach a log that is shared.
    super(
      `${method} failed: ${slackError}${needed ? ` (needs ${needed})` : ""}`,
    );
    this.name = "SlackApiError";
  }
}

export interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  thread_ts?: string;
  subtype?: string;
  blocks?: unknown;
  reactions?: { name: string; count: number; users: string[] }[];
}

export class SlackApi {
  constructor(private readonly token: string) {}

  async call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, string | number | boolean | undefined> = {},
  ): Promise<T> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) form.set(key, String(value));
    }

    const response = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: form,
    });

    const payload = (await response.json()) as Record<string, unknown>;
    if (payload.ok !== true) {
      throw new SlackApiError(
        method,
        String(payload.error ?? `http_${response.status}`),
        typeof payload.needed === "string" ? payload.needed : undefined,
      );
    }
    return payload as T;
  }

  async authTest(): Promise<{
    user_id: string;
    team_id: string;
    user: string;
    bot_id?: string;
  }> {
    return this.call("auth.test");
  }

  async postMessage(
    channel: string,
    text: string,
    threadTs?: string,
  ): Promise<string> {
    const result = await this.call<{ ts: string }>("chat.postMessage", {
      channel,
      text,
      thread_ts: threadTs,
    });
    return result.ts;
  }

  async replies(channel: string, ts: string): Promise<SlackMessage[]> {
    const result = await this.call<{ messages: SlackMessage[] }>(
      "conversations.replies",
      { channel, ts, limit: 50 },
    );
    return result.messages ?? [];
  }

  async channelInfo(channel: string): Promise<{
    name?: string;
    is_member?: boolean;
    is_private?: boolean;
  }> {
    const result = await this.call<{ channel: Record<string, unknown> }>(
      "conversations.info",
      { channel },
    );
    return result.channel as {
      name?: string;
      is_member?: boolean;
      is_private?: boolean;
    };
  }

  async openDm(userId: string): Promise<string> {
    const result = await this.call<{ channel: { id: string } }>(
      "conversations.open",
      { users: userId },
    );
    return result.channel.id;
  }

  async reactionNames(channel: string, ts: string): Promise<string[]> {
    const result = await this.call<{
      message?: { reactions?: { name: string }[] };
    }>("reactions.get", { channel, timestamp: ts, full: true });
    return (result.message?.reactions ?? []).map(r => r.name);
  }

  async deleteMessage(channel: string, ts: string): Promise<void> {
    await this.call("chat.delete", { channel, ts });
  }
}

/** Sleep helper; the harness polls Slack rather than holding connections. */
export const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

export interface PollOptions {
  timeoutMs: number;
  intervalMs?: number;
}

/**
 * Poll `probe` until it returns a value, or the deadline passes.
 *
 * Returns undefined on timeout rather than throwing so a cycle can report a
 * precise failure message instead of a generic one.
 */
export async function pollUntil<T>(
  probe: () => Promise<T | undefined>,
  { timeoutMs, intervalMs = 1500 }: PollOptions,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() >= deadline) return undefined;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
}

/**
 * True when the message is the bot's own reply.
 *
 * Identity is the bot's user id, never the presence of `bot_id`. The harness
 * drives Slack with a user token belonging to this same app, so Slack stamps
 * `bot_id` and `app_id` on the driver's messages too. Treating any `bot_id` as
 * "the bot replied" let a cycle match the message it had just posted itself,
 * and pass without the bot ever answering.
 */
export function isBotMessage(
  message: SlackMessage,
  botUserId: string,
): boolean {
  return message.user === botUserId;
}
