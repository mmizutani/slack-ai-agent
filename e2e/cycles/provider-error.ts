import { REACTIONS } from "../../src/reaction-manager";
import { containsMarker } from "../lib/markers";
import { expect, type Cycle } from "../lib/cycle";
import { pollUntil } from "../lib/slack";

/**
 * A failing provider surfaces in Slack instead of hanging.
 *
 * The phase running this cycle points the provider's base URL at a local
 * endpoint that fails every request, so the failure is deterministic and costs
 * nothing. What matters is that the user is told: a silent turn is the worst
 * outcome, and is exactly what both defects found on the first live run
 * produced.
 */
export const providerError: Cycle = {
  id: "provider-error",
  describe: "a provider failure is reported to the user, not swallowed",
  needsFakeProvider: true,
  // The provider SDKs retry with backoff before surfacing a terminal error, so
  // this path is legitimately slower than any healthy turn. Measured at ~200s
  // against a failing Anthropic endpoint.
  timeoutMs: 300_000,
  async run(ctx) {
    const marker = ctx.marker();
    const rootTs = await ctx.say(
      `Reply with exactly ${marker} and nothing else.`,
    );

    const reached = await pollUntil(
      async () => ((ctx.fakeProviderHits?.() ?? 0) > 0 ? true : undefined),
      { timeoutMs: 60_000, intervalMs: 1000 },
    );
    expect(
      reached === true,
      "the failing endpoint was never called, so the base URL override did " +
        "not reach the provider SDK — this cycle would prove nothing",
    );

    const reply = await ctx.awaitBotReply({
      channel: ctx.config.channelId,
      rootTs,
      // Anything but a successful answer. The provider cannot have produced
      // the marker, so a reply carrying it would mean the phase never actually
      // pointed at the failing endpoint.
      match: message => (message.text ?? "").length > 0,
    });

    expect(
      !containsMarker(reply.text ?? "", marker),
      "the bot answered normally, so this phase did not reach the failing " +
        "endpoint — the base URL override did not take effect",
    );

    const text = reply.text ?? "";
    expect(
      /went wrong|error|failed|❌/i.test(text),
      `the bot replied but did not report a problem: ${text.slice(0, 120)}`,
    );

    // The error reaction is the other half of the signal, and is applied after
    // the message, so it is polled rather than read once.
    const sawErrorReaction = await pollUntil(
      async () => {
        const names = await ctx.config.bot.reactionNames(
          ctx.config.channelId,
          rootTs,
        );
        return names.includes(REACTIONS.ERROR) ? true : undefined;
      },
      { timeoutMs: 15_000, intervalMs: 1000 },
    );

    return {
      evidence: `error reply ${reply.ts}${sawErrorReaction ? `; :${REACTIONS.ERROR}: applied` : `; no :${REACTIONS.ERROR}: reaction observed`}`,
    };
  },
};
