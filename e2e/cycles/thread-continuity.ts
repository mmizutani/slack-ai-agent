import { containsMarker } from "../lib/markers";
import { type Cycle } from "../lib/cycle";

/**
 * Session continuity across two turns in one thread.
 *
 * The session key is (userId, channelId, threadTs), so the follow-up is posted
 * with thread_ts set to the first message's ts. The reference code is only
 * available from the first turn, so echoing it in the second reply cannot be
 * produced by a fresh session.
 *
 * Wording matters here. An earlier version asked the bot to "remember this
 * token", and the model correctly refused on security grounds — it will not
 * store or repeat back anything it reads as a credential. That is desirable
 * behaviour, so the cycle asks about a neutral reference code instead of
 * weakening the assertion.
 */
export const threadContinuity: Cycle = {
  id: "thread-continuity",
  describe: "a follow-up in the same thread retains the earlier turn",
  async run(ctx) {
    const code = ctx.marker("code");
    const rootTs = await ctx.say(
      `The reference code for this conversation is ${code}. Reply with exactly READY.`,
    );

    await ctx.awaitBotReply({ channel: ctx.config.channelId, rootTs });

    await ctx.say(
      `What is the reference code for this conversation? Reply with the code and nothing else.`,
      { threadTs: rootTs },
    );

    const followUp = await ctx.awaitBotReply({
      channel: ctx.config.channelId,
      rootTs,
      match: message => containsMarker(message.text ?? "", code),
    });

    return { evidence: `follow-up ts ${followUp.ts}` };
  },
};
