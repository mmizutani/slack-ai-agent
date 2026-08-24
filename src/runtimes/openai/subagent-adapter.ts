import { Agent, type Tool } from "@openai/agents";
import { intersectSubagentTools } from "../../subagents/loader";
import type { SubagentDefinition } from "../../subagents/types";
import { legacyToolIdentities } from "../../mcp/permissions";

export interface OpenAISubagentPolicy {
  allowed: readonly string[];
  denied?: readonly string[];
}

export interface OpenAISubagentAdapterOptions {
  parentModel?: string;
  modelProvider?: unknown;
  availableTools?: readonly Tool[];
  createAgent?: (config: Record<string, unknown>) => Agent;
}

function toolIdentities(tool: Tool): string[] {
  const name = typeof (tool as any).name === "string" ? (tool as any).name : "";
  if (name === "workspace_read_file") return ["workspace/read_file"];
  if (name === "workspace_list_files") return ["workspace/list_files"];
  if (name === "workspace_search_text") return ["workspace/search_text"];
  const action = /^action__([^_]+)__(.+)$/.exec(name);
  if (action) return [`action:${action[1]}/${action[2]}`];
  const mcp = /^mcp__([^_]+)__(.+)$/.exec(name);
  if (mcp) return [`mcp:${mcp[1]}/${mcp[2]}`];
  return legacyToolIdentities(name);
}

function subagentToolName(name: string): string {
  return `subagent__${name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function modelFor(definition: SubagentDefinition, parentModel: string): string {
  return definition.model?.provider === "openai"
    ? definition.model.model
    : parentModel;
}

/** Build manager-style OpenAI agents-as-tools without broadening parent tools. */
export function buildOpenAISubagentTools(
  definitions: readonly SubagentDefinition[],
  parentPolicy: OpenAISubagentPolicy,
  options: OpenAISubagentAdapterOptions = {},
): Tool[] {
  const createAgent =
    options.createAgent ?? (config => new Agent(config as any));
  const parentModel = options.parentModel ?? "gpt-5.6-luna";
  const availableTools = options.availableTools ?? [];
  return definitions.map(definition => {
    const requested = intersectSubagentTools(
      parentPolicy.allowed,
      definition.tools,
      parentPolicy.denied ?? [],
      "openai",
    );
    const permitted = new Set(requested.flatMap(legacyToolIdentities));
    const childTools = availableTools.filter(tool =>
      toolIdentities(tool).some(identity => permitted.has(identity)),
    );
    const child = createAgent({
      name: definition.name,
      instructions: definition.instructions,
      description: definition.description,
      model: modelFor(definition, parentModel),
      tools: childTools,
    });
    return (child as any).asTool({
      toolName: subagentToolName(definition.name),
      toolDescription: definition.description,
      needsApproval: false,
      ...(options.modelProvider !== undefined
        ? {
            runConfig: { modelProvider: options.modelProvider },
          }
        : {}),
      ...(definition.maxTurns && {
        runOptions: { maxTurns: definition.maxTurns },
      }),
    }) as Tool;
  });
}
