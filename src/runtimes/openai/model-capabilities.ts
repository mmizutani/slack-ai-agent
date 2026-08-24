import { EffortLevel, ModelCapabilities, ModelRef, parseModelRef } from "../../agent/model";

const OPENAI_REASONING = new Set<EffortLevel>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function getOpenAIModelCapabilities(
  model?: ModelRef | string,
): ModelCapabilities {
  const modelName =
    typeof model === "string" ? parseModelRef(model).model : model?.model;
  return {
    reasoningEfforts: OPENAI_REASONING,
    supportsFastMode: false,
    supportsStreaming: true,
    supportsMcp: true,
    supportsSubagents: true,
    supportsWorkspaceRead: true,
    supportsWorkspaceWrite: false,
    supportsShell: false,
  };
}
