export const DEFAULT_OPENAI_MODEL = "gpt-5.6-luna";

export function resolveOpenAIModel(
  env: { OPENAI_MODEL?: string } = process.env,
): string {
  return env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
}
