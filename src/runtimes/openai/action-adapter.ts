import { tool, type Tool } from "@openai/agents";
import { z } from "zod";
import type { ActionToolDefinition, ActionToolResult } from "../../custom-actions/tool-definitions";

interface ActionPolicy {
  allowed?: readonly string[];
  denied?: readonly string[];
}

function actionToolName(definition: ActionToolDefinition): string {
  const server = (definition.identity.server ?? "custom-actions").replace(
    /[^a-zA-Z0-9_\-]/g,
    "_",
  );
  const name = definition.name.replace(/[^a-zA-Z0-9_\-]/g, "_");
  return `action__${server}__${name}`;
}

function parameters(inputSchema: Record<string, any>): any {
  if (inputSchema.type === "object" && inputSchema.properties) {
    return inputSchema;
  }
  // Custom actions historically expose a Zod raw shape. The Agents SDK can
  // consume the corresponding Zod object directly and performs validation.
  return z.object(inputSchema);
}

function parseInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

/** Convert provider-neutral action definitions to OpenAI function tools. */
export function buildOpenAIFunctionTools(
  definitions: readonly ActionToolDefinition[],
  policy?: ActionPolicy,
): Tool[] {
  const selected = policy
    ? definitions.filter(definition => {
        const server = definition.identity.server ?? "custom-actions";
        const identity = `action:${server}/${definition.name}`;
        const allowed = new Set(policy.allowed ?? []);
        const denied = new Set(policy.denied ?? []);
        return allowed.has(identity) && !denied.has(identity);
      })
    : definitions;
  return selected.map(definition =>
    tool({
      name: actionToolName(definition),
      description: definition.description,
      parameters: parameters(definition.inputSchema),
      // Existing Slack confirmation buttons remain the authoritative HITL
      // flow. OpenAI native interruptions are deliberately not introduced.
      needsApproval: false,
      execute: async (input: unknown, _runContext: unknown): Promise<ActionToolResult> =>
        definition.invoke(parseInput(input)),
    } as any),
  );
}
