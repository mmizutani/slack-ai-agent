/**
 * Sub-agent loader.
 *
 * Reads YAML definitions from config/subagents/ and returns them in the
 * format expected by the Claude Agent SDK's `options.agents` map.
 *
 * Each YAML file must have: name, description, model, prompt.
 * If the directory is empty or missing, no sub-agents are registered and
 * the bot continues to work normally.
 */

import { Logger } from "./logger";
import {
  loadSubagentDefinitions as loadProviderNeutralDefinitions,
} from "./subagents/loader";
import { toClaudeSubagentDefinitions } from "./runtimes/anthropic/subagent-adapter";

const logger = new Logger("SubAgents");

export { loadProviderNeutralDefinitions as loadProviderNeutralSubagentDefinitions };

/**
 * Load all sub-agent definitions from config/subagents/*.yaml.
 * Returns a map suitable for `options.agents` in the Claude Agent SDK.
 *
 * @param allowedTools - Optional tool allowlist to apply to all sub-agents.
 *   Ensures sub-agents have the same permissions as the parent agent.
 * @param disallowedTools - Optional tool denylist to apply to all sub-agents.
 */
export function loadSubagentDefinitions(
  allowedTools?: string[],
  disallowedTools?: string[],
): Record<string, unknown> {
  const definitions = loadProviderNeutralDefinitions();
  const parentTools = allowedTools ?? [];
  const agents = toClaudeSubagentDefinitions(
    definitions,
    parentTools,
    disallowedTools ?? [],
  );
  for (const definition of definitions) {
    logger.info(`Loaded sub-agent: ${definition.name}`);
  }
  return agents;
}
