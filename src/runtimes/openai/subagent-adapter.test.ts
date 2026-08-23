import { buildWorkspaceTools } from "../../workspace/tools";
import type { SubagentDefinition } from "../../subagents/types";
import { buildOpenAISubagentTools } from "./subagent-adapter";
import { buildOpenAIWorkspaceTools } from "./workspace-adapter";

describe("OpenAI subagent adapter", () => {
  it("constructs agents-as-tools with resolved model and parent-policy intersection", () => {
    const definition: SubagentDefinition = {
      name: "validator",
      description: "Validate the answer",
      model: { provider: "openai", model: "gpt-5.6-luna" },
      instructions: "Check the answer",
      tools: ["workspace/read_file", "workspace/search_text"],
    };
    const availableTools = buildOpenAIWorkspaceTools(
      buildWorkspaceTools("/tmp/work"),
      { allowed: ["workspace/read_file"] },
    );
    const createAgent = jest.fn((config: any) => ({
      ...config,
      asTool: jest.fn((options: any) => ({
        type: "function",
        name: options.toolName,
        options,
      })),
    }));

    const tools = buildOpenAISubagentTools([definition], {
      allowed: ["workspace/read_file"],
      denied: [],
    }, {
      availableTools,
      createAgent: createAgent as any,
    });

    expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({
      name: "validator",
      model: "gpt-5.6-luna",
      instructions: "Check the answer",
      tools: [expect.objectContaining({ name: "workspace_read_file" })],
    }));
    expect(tools).toEqual([
      expect.objectContaining({ name: "subagent__validator" }),
    ]);
  });

  it("does not expose an unapproved requested tool", () => {
    const definition: SubagentDefinition = {
      name: "searcher",
      description: "Search",
      instructions: "Search only",
      tools: ["workspace/search_text"],
    };
    const createAgent = jest.fn((config: any) => ({
      ...config,
      asTool: jest.fn(() => ({ type: "function", name: "subagent__searcher" })),
    }));

    buildOpenAISubagentTools([definition], {
      allowed: ["workspace/read_file"],
      denied: [],
    }, {
      availableTools: buildOpenAIWorkspaceTools(
        buildWorkspaceTools("/tmp/work"),
        { allowed: ["workspace/read_file", "workspace/search_text"] },
      ),
      createAgent: createAgent as any,
    });

    expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({ tools: [] }));
  });
});
