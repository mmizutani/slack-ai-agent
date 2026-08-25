import { buildBlockActionsBody, findButton } from "./block-actions";

const confirmationBlocks = [
  { type: "section", text: { type: "mrkdwn", text: "Confirm: e2e_echo" } },
  {
    type: "actions",
    block_id: "confirm_block",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "✅ Approve" },
        style: "primary",
        action_id: "approve_action",
        value: "e2e_echo:U1:C1:170.5",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "❌ Cancel" },
        style: "danger",
        action_id: "cancel_action",
        value: "e2e_echo:U1:C1:170.5",
      },
    ],
  },
];

describe("findButton", () => {
  it("returns the button carrying the requested action_id", () => {
    expect(findButton(confirmationBlocks, "approve_action")).toEqual({
      actionId: "approve_action",
      value: "e2e_echo:U1:C1:170.5",
      blockId: "confirm_block",
    });
  });

  it("distinguishes approve from cancel even though their values match", () => {
    expect(findButton(confirmationBlocks, "cancel_action")?.actionId).toBe(
      "cancel_action",
    );
  });

  it("returns undefined when the action_id is absent", () => {
    expect(findButton(confirmationBlocks, "nope_action")).toBeUndefined();
  });

  it("tolerates a message with no blocks at all", () => {
    expect(findButton(undefined, "approve_action")).toBeUndefined();
    expect(findButton([], "approve_action")).toBeUndefined();
  });

  it("ignores non-button elements that happen to carry an action_id", () => {
    const blocks = [
      {
        type: "actions",
        elements: [
          { type: "static_select", action_id: "approve_action" },
          {
            type: "button",
            action_id: "approve_action",
            value: "real:value",
          },
        ],
      },
    ];
    expect(findButton(blocks, "approve_action")?.value).toBe("real:value");
  });
});

describe("buildBlockActionsBody", () => {
  const button = findButton(confirmationBlocks, "approve_action")!;
  const body = buildBlockActionsBody(button, {
    teamId: "T1",
    userId: "U9",
    channelId: "C1",
    messageTs: "1700.1",
  }) as any;

  it("declares itself a block_actions interaction so Bolt routes it", () => {
    expect(body.type).toBe("block_actions");
  });

  it("carries the observed action_id and value verbatim", () => {
    // The registry parses body.actions[0].value; reproducing its encoding here
    // would couple the harness to parseButtonValue, so it is copied as-is.
    expect(body.actions[0].action_id).toBe("approve_action");
    expect(body.actions[0].value).toBe("e2e_echo:U1:C1:170.5");
  });

  it("supplies the container fields the approve handler reads", () => {
    expect(body.container.channel_id).toBe("C1");
    expect(body.container.message_ts).toBe("1700.1");
  });

  it("identifies the team, user and channel for Bolt's authorize step", () => {
    expect(body.team.id).toBe("T1");
    expect(body.user.id).toBe("U9");
    expect(body.channel.id).toBe("C1");
  });

  it("includes an empty form state rather than leaving it undefined", () => {
    // deps.formState is passed straight to the action; undefined here would
    // hide a real regression in form-carrying confirmations.
    expect(body.state).toEqual({ values: {} });
  });
});
