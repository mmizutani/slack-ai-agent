import { intersectSubagentTools } from "../../subagents/loader";
import type { SubagentDefinition } from "../../subagents/types";

export interface ClaudeSubagentDefinition {
  description: string;
  prompt: string;
  model: string;
  tools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
}

/** Map provider-neutral definitions to Claude's options.agents shape. */
export function toClaudeSubagentDefinitions(
  definitions: readonly SubagentDefinition[],
  parentAllowedTools: readonly string[],
  parentDeniedTools: readonly string[] = [],
): Record<string, ClaudeSubagentDefinition> {
  return Object.fromEntries(
    definitions.map(definition => {
      const tools = intersectSubagentTools(
        parentAllowedTools,
        definition.tools,
        parentDeniedTools,
      );
      return [
        definition.name,
        {
          description: definition.description,
          prompt: definition.instructions,
          model: definition.model?.model ?? "sonnet",
          // Always provide the computed list, including an empty list. An
          // omitted Claude `tools` field can otherwise restore provider
          // defaults and accidentally broaden an unknown/denied role.
          tools,
          ...(parentDeniedTools.length > 0 && {
            disallowedTools: [...parentDeniedTools],
          }),
          ...(definition.maxTurns !== undefined && {
            maxTurns: definition.maxTurns,
          }),
        },
      ];
    }),
  );
}
