import fs from "fs";
import path from "path";
import * as yaml from "js-yaml";
import { Logger } from "../logger";
import { parseModelRef } from "../agent/model";
import type { AgentProviderId } from "../types";
import { legacyToolIdentities } from "../mcp/permissions";
import type { SubagentDefinition } from "./types";

const logger = new Logger("SubagentLoader");

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
  const tools = value.filter(
    (tool): tool is string => typeof tool === "string",
  );
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
    ...(raw.maxTurns !== undefined && {
      maxTurns: parseMaxTurns(raw.maxTurns),
    }),
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
  const skipped: string[] = [];
  for (const file of files) {
    try {
      const parsed = yaml.load(
        fs.readFileSync(path.join(directory, file), "utf8"),
      );
      const definition = parseDefinition(parsed);
      if (definition) definitions.push(definition);
      // parseDefinition returns undefined only when name, description or
      // instructions is missing or not a string.
      else skipped.push(`${file} (missing name, description or instructions)`);
    } catch (error) {
      // Optional configuration is fail-closed per file, but a file that is
      // silently dropped looks identical to one that was never written.
      skipped.push(
        `${file} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  if (skipped.length > 0) {
    logger.warn("Skipped invalid sub-agent definition files", {
      considered: files.length,
      loaded: definitions.length,
      skipped,
    });
  }
  return definitions;
}

/**
 * Narrow a name's identities to the ones the given runtime can actually serve.
 *
 * "Read", "Grep" and "Glob" each map to two identities — the Claude native tool
 * and the OpenAI workspace alias — but computeEffectiveToolPolicy grants only
 * the native one unless the workspace alias is configured explicitly. Without
 * this narrowing, a parent policy allowing `provider_native:anthropic/Read`
 * would let a subagent asking for "Read" be handed `workspace_read_file` on the
 * OpenAI runtime, and vice versa.
 */
function identitiesForProvider(
  identities: readonly string[],
  provider?: AgentProviderId,
): string[] {
  if (!provider) return [...identities];
  return identities.filter(identity =>
    provider === "anthropic"
      ? !identity.startsWith("workspace/")
      : !identity.startsWith("provider_native:anthropic/"),
  );
}

/**
 * Restrict a subagent request to the parent's effective legacy tool policy.
 * Matching is performed on canonical identities, while the returned names
 * remain in the form requested by the provider adapter.
 *
 * The allow check runs against the identities the runtime can serve; the deny
 * check runs against every identity the name maps to, so denying either half of
 * a legacy alias rejects the name outright.
 */
export function intersectSubagentTools(
  parentAllowedTools: readonly string[],
  requestedTools?: readonly string[],
  parentDeniedTools: readonly string[] = [],
  provider?: AgentProviderId,
): string[] {
  const parentAllowed = new Set(
    parentAllowedTools.flatMap(legacyToolIdentities),
  );
  const parentDenied = new Set(parentDeniedTools.flatMap(legacyToolIdentities));
  const candidates = requestedTools ?? parentAllowedTools;
  return candidates.filter(tool => {
    const identities = legacyToolIdentities(tool);
    const grantable = identitiesForProvider(identities, provider);
    return (
      grantable.length > 0 &&
      grantable.some(identity => parentAllowed.has(identity)) &&
      identities.every(identity => !parentDenied.has(identity))
    );
  });
}

export type { SubagentDefinition } from "./types";
