import { containsMarker } from "../lib/markers";
import { expect, type Cycle } from "../lib/cycle";

/**
 * An @-mention in a public channel — the most common way the bot is used.
 *
 * Also guards the `channels:read` scope. Without it `lookupChannelType` fails
 * closed to "im" (src/channel-config.ts), so the bot still replies but treats a
 * public channel as a DM: the conditional-reply branch is skipped and DM
 * privacy redaction is applied. The reply alone would not reveal that, so the
 * cycle asserts the warning that failure logs is absent.
 */
export const channelMention: Cycle = {
  id: "channel-mention",
  describe: "@-mention in a public channel is answered in thread",
  async run(ctx) {
    const marker = ctx.marker();
    const rootTs = await ctx.say(
      `Reply with exactly ${marker} and nothing else.`,
    );

    const reply = await ctx.awaitBotReply({
      channel: ctx.config.channelId,
      rootTs,
      match: message => containsMarker(message.text ?? "", marker),
    });

    expect(
      !/Failed to look up channel type/.test(ctx.logsSinceStart()),
      "the app could not resolve the channel type, so it processed a public " +
        "channel as a DM — the bot is missing the channels:read scope",
    );

    return { evidence: `reply ts ${reply.ts}` };
  },
};
