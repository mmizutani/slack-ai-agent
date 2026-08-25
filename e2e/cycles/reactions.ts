import { REACTIONS } from "../../src/reaction-manager";
import { containsMarker } from "../lib/markers";
import { expect, type Cycle } from "../lib/cycle";
import { pollUntil, sleep } from "../lib/slack";

/**
 * The reaction lifecycle the bot puts on the user's own message.
 *
 * Emoji names come from the same loader the app uses, so a deployment that
 * customises config/emojis.yaml does not break this cycle.
 *
 * Only the terminal reaction is asserted. The in-progress reaction is observed
 * on a best-effort basis and reported as evidence: it is replaced when the turn
 * finishes, so a fast turn can legitimately complete between two polls, and
 * asserting it would make the cycle flaky rather than strict.
 */
export const reactions: Cycle = {
  id: "reactions",
  describe: "the bot marks the user's message complete when it finishes",
  async run(ctx) {
    const marker = ctx.marker();
    const rootTs = await ctx.say(
      `Reply with exactly ${marker} and nothing else.`,
    );

    const seen = new Set<string>();
    const sawTerminal = await pollUntil(
      async () => {
        const names = await ctx.config.bot.reactionNames(
          ctx.config.channelId,
          rootTs,
        );
        names.forEach(name => seen.add(name));
        if (names.includes(REACTIONS.COMPLETE)) return true;
        if (names.includes(REACTIONS.ERROR)) {
          throw new Error(
            `the bot marked the message with :${REACTIONS.ERROR}:`,
          );
        }
        await sleep(300);
        return undefined;
      },
      { timeoutMs: ctx.config.cycleTimeoutMs, intervalMs: 400 },
    );

    expect(
      sawTerminal === true,
      `the bot never added :${REACTIONS.COMPLETE}: (saw ${[...seen].join(", ") || "no reactions"})`,
    );

    await ctx.awaitBotReply({
      channel: ctx.config.channelId,
      rootTs,
      match: message => containsMarker(message.text ?? "", marker),
    });

    const inProgress =
      seen.has(REACTIONS.THINKING) || seen.has(REACTIONS.TOOL_USE);
    return {
      evidence: `reactions observed: ${[...seen].join(", ")}${inProgress ? "" : " (in-progress reaction not observed; turn finished between polls)"}`,
    };
  },
};
