import { buildBlockActionsBody, findButton } from "../lib/block-actions";
import { expect, type Cycle } from "../lib/cycle";
import { isBotMessage, pollUntil } from "../lib/slack";

const APPROVE_ACTION_ID = "approve_action";

/**
 * The human-in-the-loop approval path, end to end.
 *
 * Slack exposes no Web API that originates a Block Kit click, so the click is
 * delivered through Bolt's public processEvent in the host process. Everything
 * either side of that is real: the confirmation message is posted to the real
 * workspace by the real registry, the payload's action_id and value are read
 * back off that message rather than reconstructed, and the action's effect is
 * asserted as a real message in the real thread.
 *
 * The boundary is worth stating plainly: this verifies our handler chain and
 * its Slack side effects, not Slack's delivery of the click itself.
 */
export const buttonApproval: Cycle = {
  id: "button-approval",
  describe: "an approval button runs the action and posts its effect",
  profile: "actions" as const,
  async run(ctx) {
    expect(ctx.fixtures !== undefined, "action fixtures were not installed");

    const code = ctx.marker();
    const rootTs = await ctx.say(`Record the verification code ${code}.`);

    // The confirmation dialog is a bot message carrying an approve button.
    const confirmation = await pollUntil(
      async () => {
        const messages = await ctx.config.bot.replies(
          ctx.config.channelId,
          rootTs,
        );
        return messages.find(
          message =>
            message.ts !== rootTs &&
            isBotMessage(message, ctx.config.botUserId) &&
            findButton(message.blocks, APPROVE_ACTION_ID) !== undefined,
        );
      },
      { timeoutMs: ctx.config.cycleTimeoutMs },
    );

    expect(
      confirmation !== undefined,
      "the agent never posted an approval dialog, so the action was not " +
        "offered or was not called",
    );
    ctx.track({
      channel: ctx.config.channelId,
      ts: confirmation.ts,
      as: "bot",
    });

    const button = findButton(confirmation.blocks, APPROVE_ACTION_ID)!;
    await ctx.host.inject(
      buildBlockActionsBody(button, {
        teamId: ctx.config.teamId,
        userId: ctx.config.driverUserId,
        channelId: ctx.config.channelId,
        messageTs: confirmation.ts,
      }),
    );

    const effect = await ctx.awaitBotReply({
      channel: ctx.config.channelId,
      rootTs,
      match: message => (message.text ?? "").includes(`ACTION-OK-${code}`),
    });

    return {
      evidence: `dialog ${confirmation.ts}; effect ${effect.ts} (click injected via processEvent)`,
    };
  },
};
