import { expect, type Cycle } from "../lib/cycle";
import { isBotMessage, pollUntil, sleep } from "../lib/slack";

/** Grace period after the first reply, to catch a second one arriving late. */
const SETTLE_MS = 12_000;

/**
 * A burst of messages in one thread collapses into a single answer.
 *
 * SlackHandler folds rapid follow-ups: claimLatestSessionMessage marks the
 * newest message as the one that answers the whole thread and aborts the
 * in-flight handling of the earlier one.
 *
 * The assertion is deliberately *not* that the reply echoes the second
 * message's marker. The app's contract is that the surviving turn answers the
 * whole burst, with both messages' text folded into one query, so which
 * instruction the model follows is its choice — an earlier version of this
 * cycle asserted the second marker and failed against correct behaviour. What
 * must hold is that exactly one answer is produced and that the first turn was
 * really cancelled rather than merely finishing first.
 */
export const cancellation: Cycle = {
  id: "cancellation",
  describe:
    "a burst in one thread yields one answer and cancels the first turn",
  async run(ctx) {
    const first = ctx.marker("first");
    const second = ctx.marker("second");

    const rootTs = await ctx.say(
      `Reply with exactly ${first} and nothing else.`,
    );

    // Wait for the app to actually pick the first message up, rather than
    // assuming a fixed delay is enough. A sleep that is too short sends the
    // follow-up before there is anything in flight to cancel, and the cycle
    // then passes or fails on machine speed. The app logs a permalink whose id
    // is the timestamp with the dot removed.
    const started = await pollUntil(
      async () =>
        ctx.logsSinceStart().includes(`p${rootTs.replace(".", "")}`)
          ? true
          : undefined,
      { timeoutMs: 30_000, intervalMs: 200 },
    );
    expect(
      started === true,
      "the app never logged receipt of the first message, so there was " +
        "nothing in flight for the follow-up to supersede",
    );
    await ctx.say(
      `Ignore my previous message. Reply with exactly ${second} and nothing else.`,
      { threadTs: rootTs },
    );

    await ctx.awaitBotReply({ channel: ctx.config.channelId, rootTs });
    await sleep(SETTLE_MS);

    const messages = await ctx.config.bot.replies(ctx.config.channelId, rootTs);
    const botReplies = messages.filter(
      message =>
        message.ts !== rootTs && isBotMessage(message, ctx.config.botUserId),
    );
    botReplies.forEach(message =>
      ctx.track({ channel: ctx.config.channelId, ts: message.ts, as: "bot" }),
    );

    expect(
      botReplies.length === 1,
      `the burst produced ${botReplies.length} replies; coalescing should ` +
        "fold it into exactly one",
    );

    const logs = ctx.logsSinceStart();
    const superseded = /superseded by a newer thread reply/.test(logs);
    // An aborted turn completes having emitted nothing.
    const abortedTurn =
      /Completed \{"provider":"[a-z]+","msgs":0,"tools":0,"turns":0\}/.test(
        logs,
      );
    expect(
      superseded || abortedTurn,
      "one reply arrived, but the app never reported superseding or " +
        "abandoning the first turn — the burst may have been processed " +
        "serially, which does not exercise cancellation",
    );

    return {
      evidence: `one reply ${botReplies[0]?.ts}; first turn ${superseded ? "superseded" : "abandoned"}`,
    };
  },
};
