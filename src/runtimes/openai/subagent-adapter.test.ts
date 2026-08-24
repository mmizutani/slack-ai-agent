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

    const tools = buildOpenAISubagentTools(
      [definition],
      {
        allowed: ["workspace/read_file"],
        denied: [],
      },
      {
        availableTools,
        createAgent: createAgent as any,
      },
    );

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "validator",
        model: "gpt-5.6-luna",
        instructions: "Check the answer",
        tools: [expect.objectContaining({ name: "workspace_read_file" })],
      }),
    );
    expect(tools).toEqual([
      expect.objectContaining({ name: "subagent__validator" }),
    ]);
  });

  // action__/mcp__ server segments may contain underscores. A greedy [^_]+
  // segment fails to match those names at all, so the tool resolves to no
  // identity and is silently dropped from the child agent.
  it("matches an action tool whose server segment contains underscores", () => {
    const definition: SubagentDefinition = {
      name: "filer",
      description: "File",
      instructions: "File tickets",
      tools: ["action:release_ops/create_ticket"],
    };
    const createAgent = jest.fn((config: any) => ({
      ...config,
      asTool: jest.fn(() => ({ type: "function", name: "subagent__filer" })),
    }));

    buildOpenAISubagentTools(
      [definition],
      { allowed: ["action:release_ops/create_ticket"], denied: [] },
      {
        availableTools: [
          { name: "action__release_ops__create_ticket" } as any,
          { name: "action__release_ops__delete_ticket" } as any,
        ],
        createAgent: createAgent as any,
      },
    );

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [
          expect.objectContaining({
            name: "action__release_ops__create_ticket",
          }),
        ],
      }),
    );
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

    buildOpenAISubagentTools(
      [definition],
      {
        allowed: ["workspace/read_file"],
        denied: [],
      },
      {
        availableTools: buildOpenAIWorkspaceTools(
          buildWorkspaceTools("/tmp/work"),
          { allowed: ["workspace/read_file", "workspace/search_text"] },
        ),
        createAgent: createAgent as any,
      },
    );

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ tools: [] }),
    );
  });

  // The parent policy grants the Claude native Read, not the OpenAI workspace
  // alias. A subagent asking for the legacy name must not receive
  // workspace_read_file on the strength of that grant.
  it("does not turn a legacy Read grant into the OpenAI workspace tool", () => {
    const definition: SubagentDefinition = {
      name: "reader",
      description: "Read",
      instructions: "Read only",
      tools: ["Read"],
    };
    const createAgent = jest.fn((config: any) => ({
      ...config,
      asTool: jest.fn(() => ({ type: "function", name: "subagent__reader" })),
    }));

    buildOpenAISubagentTools(
      [definition],
      { allowed: ["provider_native:anthropic/Read"], denied: [] },
      {
        availableTools: buildOpenAIWorkspaceTools(
          buildWorkspaceTools("/tmp/work"),
          {
            allowed: ["workspace/read_file"],
          },
        ),
        createAgent: createAgent as any,
      },
    );

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ tools: [] }),
    );
  });

  it("exposes the workspace tool when the parent policy names it explicitly", () => {
    const definition: SubagentDefinition = {
      name: "reader",
      description: "Read",
      instructions: "Read only",
      tools: ["Read"],
    };
    const createAgent = jest.fn((config: any) => ({
      ...config,
      asTool: jest.fn(() => ({ type: "function", name: "subagent__reader" })),
    }));

    buildOpenAISubagentTools(
      [definition],
      { allowed: ["workspace/read_file"], denied: [] },
      {
        availableTools: buildOpenAIWorkspaceTools(
          buildWorkspaceTools("/tmp/work"),
          {
            allowed: ["workspace/read_file"],
          },
        ),
        createAgent: createAgent as any,
      },
    );

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [expect.objectContaining({ name: "workspace_read_file" })],
      }),
    );
  });
});
