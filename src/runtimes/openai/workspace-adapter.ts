import { tool, type Tool } from "@openai/agents";
import type { WorkspaceToolDefinition } from "../../workspace/tools";

interface WorkspacePolicy {
  allowed?: readonly string[];
  denied?: readonly string[];
}

const CANONICAL_BY_NAME: Record<WorkspaceToolDefinition["name"], string> = {
  workspace_read_file: "workspace/read_file",
  workspace_list_files: "workspace/list_files",
  workspace_search_text: "workspace/search_text",
};

/** Convert safe provider-neutral workspace definitions to OpenAI tools. */
export function buildOpenAIWorkspaceTools(
  definitions: readonly WorkspaceToolDefinition[],
  policy: WorkspacePolicy,
): Tool[] {
  const allowed = new Set(policy.allowed ?? []);
  const denied = new Set(policy.denied ?? []);
  return definitions
    .filter(definition => {
      const identity = CANONICAL_BY_NAME[definition.name];
      return allowed.has(identity) && !denied.has(identity);
    })
    .map(definition =>
      tool({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters as any,
        execute: async (input: unknown) => definition.execute(input),
      } as any),
    );
}
