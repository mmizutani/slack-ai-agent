import { containsMarker } from "../lib/markers";
import { expect, type Cycle } from "../lib/cycle";

/**
 * A direct message.
 *
 * The DM channel is opened with the bot token, not the driver token: the driver
 * (a user token) holds chat:write but not im:write, so it can post into an IM
 * channel but cannot create one. The bot can.
 */
export const dm: Cycle = {
  id: "dm",
  describe: "direct message is answered",
  async run(ctx) {
    const marker = ctx.marker();
    const channel = await ctx.config.bot.openDm(ctx.config.driverUserId);

    const rootTs = await ctx.say(
      `Reply with exactly ${marker} and nothing else.`,
      { channel },
    );

    const reply = await ctx.awaitBotReply({
      channel,
      rootTs,
      match: message => containsMarker(message.text ?? "", marker),
    });

    expect(reply.ts !== rootTs, "the bot echoed the driver's own message");
    return { evidence: `dm ${channel} reply ts ${reply.ts}` };
  },
};
