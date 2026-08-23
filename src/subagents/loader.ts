import fs from "fs";
import path from "path";
import * as yaml from "js-yaml";
import { parseModelRef } from "../agent/model";
import { legacyToolIdentities } from "../mcp/permissions";
import type { SubagentDefinition } from "./types";

const MODEL_ALIASES: Record<string, string> = {
  haiku: "anthropic/claude-haiku-4-5",
  sonnet: "anthropic/claude-sonnet-5",
  opus: "anthropic/claude-opus-5",
  fable: "anthropic/claude-fable-5",
};

interface RawSubagentDefinition {
  name?: unknown;
  description?: unknown;
  model?: unknown;
  prompt?: unknown;
  instructions?: unknown;
  tools?: unknown;
  maxTurns?: unknown;
}

function parseModel(value: unknown): SubagentDefinition["model"] {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return parseModelRef(MODEL_ALIASES[value.trim().toLowerCase()] ?? value);
}

function parseTools(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return [];
  const tools = value.filter((tool): tool is string => typeof tool === "string");
  return tools.length > 0 ? tools : [];
}

function parseMaxTurns(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const maxTurns = Math.floor(value);
  return maxTurns > 0 ? maxTurns : undefined;
}

function parseDefinition(value: unknown): SubagentDefinition | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as RawSubagentDefinition;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const description =
    typeof raw.description === "string" ? raw.description.trim() : "";
  const instructionsValue = raw.instructions ?? raw.prompt;
  const instructions =
    typeof instructionsValue === "string" ? instructionsValue.trim() : "";
  if (!name || !description || !instructions) return undefined;

  return {
    name,
    description,
    model: parseModel(raw.model),
    instructions,
    ...(raw.tools !== undefined && { tools: parseTools(raw.tools) }),
    ...(raw.maxTurns !== undefined && { maxTurns: parseMaxTurns(raw.maxTurns) }),
  };
}

/**
 * Load provider-neutral subagent definitions. Invalid files are skipped so a
 * broken optional definition cannot disable the Slack agent altogether.
 */
export function loadSubagentDefinitions(
  directory: string = path.resolve("config/subagents"),
): SubagentDefinition[] {
  if (!fs.existsSync(directory)) return [];
  let files: string[];
  try {
    files = fs
      .readdirSync(directory)
      .filter(
        file =>
          (file.endsWith(".yaml") || file.endsWith(".yml")) &&
          !file.startsWith("example-"),
      );
  } catch {
    return [];
  }

  const definitions: SubagentDefinition[] = [];
  for (const file of files) {
    try {
      const parsed = yaml.load(
        fs.readFileSync(path.join(directory, file), "utf8"),
      );
      const definition = parseDefinition(parsed);
      if (definition) definitions.push(definition);
    } catch {
      // Optional configuration is fail-closed per file.
    }
  }
  return definitions;
}

/**
 * Restrict a subagent request to the parent's effective legacy tool policy.
 * Matching is performed on canonical identities, while the returned names
 * remain in the form requested by the provider adapter.
 */
export function intersectSubagentTools(
  parentAllowedTools: readonly string[],
  requestedTools?: readonly string[],
  parentDeniedTools: readonly string[] = [],
): string[] {
  const parentAllowed = new Set(
    parentAllowedTools.flatMap(legacyToolIdentities),
  );
  const parentDenied = new Set(parentDeniedTools.flatMap(legacyToolIdentities));
  const candidates = requestedTools ?? parentAllowedTools;
  return candidates.filter(tool => {
    const identities = legacyToolIdentities(tool);
    return (
      identities.length > 0 &&
      identities.some(identity => parentAllowed.has(identity)) &&
      identities.every(identity => !parentDenied.has(identity))
    );
  });
}

export type { SubagentDefinition } from "./types";
