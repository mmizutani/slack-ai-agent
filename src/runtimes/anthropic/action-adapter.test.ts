import type { ActionToolDefinition } from "../../custom-actions/tool-definitions";
import { buildClaudeActionMcpServers } from "./action-adapter";

describe("Claude custom action adapter", () => {
  it("converts provider-neutral definitions into Claude MCP tools", async () => {
    const tool = jest.fn((name: string, description: string, schema: unknown, handler: unknown) => ({
      name,
      description,
      schema,
      handler,
    }));
    const createSdkMcpServer = jest.fn((options: unknown) => options);
    const definition: ActionToolDefinition = {
      identity: { kind: "action", server: "actions", name: "create-ticket" },
      name: "create-ticket",
      description: "Create a ticket",
      inputSchema: {},
      requiresApproval: true,
      invoke: jest.fn().mockResolvedValue({
        text: "confirmation posted",
        suppressReply: true,
        confirmationDialogPosted: true,
      }),
    };

    const servers = await buildClaudeActionMcpServers([definition], {
      tool,
      createSdkMcpServer,
    });

    expect(Object.keys(servers)).toEqual(["actions"]);
    expect(createSdkMcpServer).toHaveBeenCalledWith({
      name: "actions",
      tools: [expect.objectContaining({ name: "create-ticket" })],
    });
    const handler = (tool.mock.calls[0]?.[3] as (args: unknown) => Promise<unknown>);
    await expect(handler({ title: "Bug" })).resolves.toEqual({
      content: [{ type: "text", text: "confirmation posted" }],
      structuredContent: {
        suppressReply: true,
        confirmationDialogPosted: true,
      },
    });
  });
});
