import type { ProviderId } from "./report";

/** Cheap models, chosen so the suite can be run often without thought. */
export const PHASE_MODEL: Record<ProviderId, string> = {
  anthropic: "anthropic/claude-haiku-4-5",
  openai: "openai/gpt-5.6-luna",
};

const API_KEY_VAR: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

const BASE_URL_VAR: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_BASE_URL",
  openai: "OPENAI_BASE_URL",
};

export interface PhaseEnvOptions {
  provider: ProviderId;
  /** Fixture MCP configuration, so the deployment's own file is untouched. */
  mcpConfigPath?: string;
  /** Fixture custom actions, so config/custom-actions/ is untouched. */
  customActionsDir?: string;
  /** Local endpoint used by the failure-path phase. Free and deterministic. */
  providerBaseUrl?: string;
}

/**
 * Build the environment for one verification phase.
 *
 * The other provider's API key is blanked rather than merely ignored: with both
 * keys present `resolveEnabledProviders` enables both runtimes, so a regression
 * in single-provider startup — an explicit exit criterion of the OpenAI design
 * — would never be exercised.
 *
 * Blanked, not deleted. The child imports `src/config.ts`, which calls
 * `dotenv.config()`, and dotenv populates any variable missing from the
 * environment. Deleting a key therefore hands it straight back from `.env`,
 * silently re-enabling the provider this phase is meant to exclude. An empty
 * string is present as far as dotenv is concerned and falsy everywhere the
 * application tests it.
 *
 * Returns a copy; the caller's environment is never mutated.
 */
export function phaseEnv(
  base: NodeJS.ProcessEnv,
  options: PhaseEnvOptions,
): NodeJS.ProcessEnv {
  const { provider } = options;
  const env: NodeJS.ProcessEnv = { ...base };

  env.AGENT_DEFAULT_PROVIDER = provider;
  env.AGENT_DEFAULT_MODEL = PHASE_MODEL[provider];

  for (const other of Object.keys(API_KEY_VAR) as ProviderId[]) {
    if (other !== provider) env[API_KEY_VAR[other]] = "";
    env[BASE_URL_VAR[other]] = "";
  }

  env[BASE_URL_VAR[provider]] = options.providerBaseUrl ?? "";

  if (options.mcpConfigPath) env.MCP_CONFIG_PATH = options.mcpConfigPath;
  if (options.customActionsDir) {
    env.CUSTOM_ACTIONS_DIR = options.customActionsDir;
  }

  return env;
}
