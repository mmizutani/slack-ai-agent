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

const DEFAULT_CLAUDE_SUBAGENT_MODEL = "sonnet";

/**
 * A subagent YAML file may declare a model for either provider. Handing an
 * OpenAI name to Claude produces a provider rejection at run time, so fall back
 * to the Claude default. The OpenAI adapter guards the mirror-image case in
 * modelFor.
 */
function modelFor(definition: SubagentDefinition): string {
  return definition.model?.provider === "anthropic"
    ? definition.model.model
    : DEFAULT_CLAUDE_SUBAGENT_MODEL;
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
        "anthropic",
      );
      return [
        definition.name,
        {
          description: definition.description,
          prompt: definition.instructions,
          model: modelFor(definition),
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
