import type { ActionSlackContext, CustomAction } from "./types";
import { CustomActionRegistry } from "./registry";

jest.mock("../config", () => ({
  config: {
    persistDir: "/tmp/slack-ai-agent-action-tests",
  },
}));

jest.mock("../reaction-manager", () => ({
  REACTIONS: {
    ERROR: "x",
    COMPLETE: "white_check_mark",
    WAITING_ON_HUMAN: "hourglass_flowing_sand",
  },
}));

describe("provider-neutral custom action tool definitions", () => {
  const context = {
    userId: "U123",
    channel: "C123",
    channelType: "channel",
    messageTs: "1700000000.000100",
  } as ActionSlackContext;

  const makeAction = (overrides: Partial<CustomAction<unknown>> = {}) =>
    ({
      name: "create-ticket",
      description: "Create a ticket",
      inputSchema: {},
      buildConfirmationBlocks: jest.fn().mockResolvedValue([]),
      execute: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    }) as CustomAction<unknown>;

  it("exposes an action definition whose invocation keeps structured suppression", async () => {
    const app = {
      client: {
        chat: {
          postMessage: jest.fn().mockResolvedValue({ ts: "dialog-ts" }),
        },
      },
    } as any;
    const reactionManager = {
      updateReaction: jest.fn().mockResolvedValue(undefined),
    } as any;
    const registry = new CustomActionRegistry(app, reactionManager);
    registry.register(makeAction());

    const [definition] = registry.getActionToolDefinitions(context);
    const result = await definition.invoke({ title: "Bug" });

    expect(definition.identity).toEqual({
      kind: "action",
      server: "custom-actions",
      name: "create-ticket",
    });
    expect(result).toMatchObject({
      suppressReply: true,
      confirmationDialogPosted: true,
    });
    expect(result.text).toContain("confirmation dialog");
  });

  it("does not broaden requested subagent tools beyond the parent policy", async () => {
    const { intersectSubagentTools } = await import("../subagents/loader");

    expect(
      intersectSubagentTools(
        ["Read", "mcp__github__get_file_contents"],
        ["Read", "Bash", "mcp__github__get_file_contents"],
      ),
    ).toEqual(["Read", "mcp__github__get_file_contents"]);
  });
});
