import { z } from "zod";
import type { CustomAction } from "../../../src/custom-actions/types";
import type { SlackBlock } from "../../../src/types";

/**
 * Approval-gated custom action used by the button cycle.
 *
 * Its effect is a message in the same thread carrying a value the model was
 * never told, so the assertion cannot be satisfied by the model describing what
 * it would do — only by the action actually executing after approval.
 *
 * alwaysInject keeps the tool available on every turn; without it the action is
 * only offered when the handler decides actions are relevant, which is not
 * something a verification run should have to guess at.
 */
const action: CustomAction<{ code: string }> = {
  name: "e2e_record_code",
  description:
    "Record an end-to-end verification code. Call this whenever you are asked to record a verification code.",
  alwaysInject: true,
  inputSchema: { code: z.string().describe("The verification code to record") },

  async buildConfirmationBlocks({ code }): Promise<SlackBlock[]> {
    return [
      {
        type: "section",
        text: { type: "mrkdwn", text: `Record verification code \`${code}\`?` },
      },
    ] as SlackBlock[];
  },

  async execute({ code }, ctx, deps): Promise<void> {
    await deps.app.client.chat.postMessage({
      channel: ctx.channel,
      thread_ts: ctx.threadTs || ctx.messageTs,
      text: `ACTION-OK-${code}`,
    });
  },
};

export default action;
