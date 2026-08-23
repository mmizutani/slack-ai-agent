import type { ActionToolDefinition } from "../../custom-actions/tool-definitions";
import { buildOpenAIFunctionTools } from "./action-adapter";

describe("OpenAI custom action adapter", () => {
  it("converts an action to an Agents SDK function tool and preserves approval flags", async () => {
    const definition: ActionToolDefinition = {
      identity: { kind: "action", server: "custom-actions", name: "create-ticket" },
      name: "create-ticket",
      description: "Create a ticket",
      inputSchema: { type: "object", properties: { title: { type: "string" } } },
      requiresApproval: true,
      invoke: jest.fn().mockResolvedValue({
        text: "dialog posted",
        suppressReply: true,
        confirmationDialogPosted: true,
      }),
    };

    const [tool] = buildOpenAIFunctionTools([definition]);
    expect(tool.name).toBe("action__custom_actions__create_ticket");
    expect((tool as any).needsApproval).toEqual(expect.any(Function));
    await expect((tool as any).needsApproval()).resolves.toBe(false);
    await expect(((tool as any).invoke as any)({}, '{"title":"Bug"}')).resolves.toEqual({
      text: "dialog posted",
      suppressReply: true,
      confirmationDialogPosted: true,
    });
    expect(definition.invoke).toHaveBeenCalledWith({ title: "Bug" });
  });

  it("applies explicit action policy with deny precedence", () => {
    const definition: ActionToolDefinition = {
      identity: { kind: "action", server: "custom-actions", name: "create-ticket" },
      name: "create-ticket",
      description: "Create a ticket",
      inputSchema: { type: "object", properties: {} },
      requiresApproval: true,
      invoke: jest.fn(),
    };

    expect(
      buildOpenAIFunctionTools([definition], {
        allowed: ["action:custom-actions/create-ticket"],
        denied: ["action:custom-actions/create-ticket"],
      }),
    ).toHaveLength(0);
  });

  it("exposes no actions when the effective role policy grants none", () => {
    const definition: ActionToolDefinition = {
      identity: {
        kind: "action",
        server: "custom-actions",
        name: "create-ticket",
      },
      name: "create-ticket",
      description: "Create a ticket",
      inputSchema: { type: "object", properties: {} },
      requiresApproval: true,
      invoke: jest.fn(),
    };

    expect(
      buildOpenAIFunctionTools([definition], { allowed: [], denied: [] }),
    ).toHaveLength(0);
  });
});
