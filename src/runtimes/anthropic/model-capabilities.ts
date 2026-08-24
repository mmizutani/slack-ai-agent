import { EffortLevel, ModelCapabilities, ModelRef, parseModelRef } from "../../agent/model";

const ALL_REASONING = new Set<EffortLevel>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function getAnthropicModelCapabilities(
  model?: ModelRef | string,
): ModelCapabilities {
  const modelName =
    typeof model === "string" ? parseModelRef(model).model : model?.model;
  const normalizedModelName = modelName?.toLowerCase();
  const isHaiku = normalizedModelName?.includes("haiku");
  return {
    reasoningEfforts: isHaiku ? new Set() : ALL_REASONING,
    supportsFastMode:
      normalizedModelName === undefined || normalizedModelName.includes("opus"),
    supportsStreaming: true,
    supportsMcp: true,
    supportsSubagents: true,
    supportsWorkspaceRead: true,
    supportsWorkspaceWrite: true,
    supportsShell: true,
  };
}
