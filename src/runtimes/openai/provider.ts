import {
  OpenAIProvider,
  type OpenAIProviderOptions,
  Runner,
  type ModelProvider,
} from "@openai/agents";

export interface OpenAIProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  organization?: string;
  project?: string;
  tracingEnabled?: boolean;
}

/** Construct the official Agents SDK OpenAI Responses provider. */
export function createOpenAIProvider(
  config: OpenAIProviderConfig = {},
): OpenAIProvider {
  const options: OpenAIProviderOptions = {
    ...(config.apiKey !== undefined && { apiKey: config.apiKey }),
    ...(config.baseUrl !== undefined && { baseURL: config.baseUrl }),
    ...(config.organization !== undefined && {
      organization: config.organization,
    }),
    ...(config.project !== undefined && { project: config.project }),
    useResponses: true,
  };
  return new OpenAIProvider(options);
}

/**
 * Create a runner with tracing disabled unless explicitly enabled. Sensitive
 * model/tool payloads are never included in traces by this runtime.
 */
export function createOpenAIRunner(
  provider: ModelProvider,
  tracingEnabled = false,
): Runner {
  return new Runner({
    modelProvider: provider,
    tracingDisabled: !tracingEnabled,
    traceIncludeSensitiveData: false,
  });
}
