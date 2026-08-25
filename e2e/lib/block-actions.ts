/**
 * Construction of the one interaction Slack cannot originate for us.
 *
 * Slack exposes no Web API that produces a Block Kit button click, so the
 * harness assembles the `block_actions` body Slack would have delivered and
 * feeds it to Bolt's public `App#processEvent`. Everything downstream of that
 * — Bolt's middleware chain, the registry's `approve_action` handler, and the
 * `chat.update` / `chat.postMessage` it performs — is the real code path
 * against the real workspace.
 */

export interface ObservedButton {
  actionId: string;
  value: string;
  blockId?: string;
}

export interface ButtonClickContext {
  teamId: string;
  userId: string;
  channelId: string;
  /** Timestamp of the confirmation message the button is attached to. */
  messageTs: string;
}

interface BlockLike {
  type?: string;
  block_id?: string;
  elements?: ElementLike[];
}

interface ElementLike {
  type?: string;
  action_id?: string;
  value?: string;
}

/**
 * Locate a rendered button by action_id.
 *
 * The button's `value` is read back off the live message rather than rebuilt,
 * so the harness never duplicates the registry's encoding of
 * `<actionName>:<sessionKey>` and cannot drift from it.
 */
export function findButton(
  blocks: unknown,
  actionId: string,
): ObservedButton | undefined {
  if (!Array.isArray(blocks)) return undefined;

  for (const block of blocks as BlockLike[]) {
    if (!Array.isArray(block?.elements)) continue;
    for (const element of block.elements) {
      // A select can carry the same action_id; only a button is clickable in
      // the sense this harness means.
      if (element?.type !== "button") continue;
      if (element.action_id !== actionId) continue;
      return {
        actionId,
        value: element.value ?? "",
        ...(block.block_id !== undefined && { blockId: block.block_id }),
      };
    }
  }
  return undefined;
}

/** Assemble the `block_actions` body for a click on `button`. */
export function buildBlockActionsBody(
  button: ObservedButton,
  ctx: ButtonClickContext,
): Record<string, unknown> {
  return {
    type: "block_actions",
    team: { id: ctx.teamId, domain: "e2e" },
    user: { id: ctx.userId, team_id: ctx.teamId },
    api_app_id: "e2e",
    channel: { id: ctx.channelId },
    container: {
      type: "message",
      channel_id: ctx.channelId,
      message_ts: ctx.messageTs,
      is_ephemeral: false,
    },
    message: { ts: ctx.messageTs },
    // The registry forwards body.state.values to the action as formState. An
    // absent state would exercise a different branch than a real click does.
    state: { values: {} },
    actions: [
      {
        type: "button",
        action_id: button.actionId,
        value: button.value,
        action_ts: ctx.messageTs,
        ...(button.blockId !== undefined && { block_id: button.blockId }),
      },
    ],
  };
}
