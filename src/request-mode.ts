import { EffortLevel, ModelRef, tryParseModelRef } from "./agent/model";
import { getAnthropicModelCapabilities } from "./runtimes/anthropic/model-capabilities";
import { getOpenAIModelCapabilities } from "./runtimes/openai/model-capabilities";

export type { EffortLevel } from "./agent/model";

export type AllowedModel =
  | "claude-opus-5"
  | "claude-sonnet-5"
  | "claude-haiku-4-5"
  | "claude-fable-5";

export type ModelSetting = AllowedModel | string | ModelRef;

export interface RequestMode {
  model?: ModelSetting;
  effort?: EffortLevel;
  fast?: boolean;
}

export interface ChannelModeConfig {
  model?: ModelSetting;
  effort?: EffortLevel;
  /** Regex tested against message text; fast mode activates on match. Use ".*" for always-on. */
  fastModePattern?: string;
  /** Fast mode activates when the user @-mentions the bot. */
  fastModeTagBot?: boolean;
}

export function mergeChannelModeDefaults(
  channelMode: ChannelModeConfig | undefined,
  defaultModel: ModelSetting,
): ChannelModeConfig {
  return { model: defaultModel, ...channelMode };
}

export const OPUS_MODEL: AllowedModel = "claude-opus-5";
export const SONNET_MODEL: AllowedModel = "claude-sonnet-5";
export const HAIKU_MODEL: AllowedModel = "claude-haiku-4-5";
export const FABLE_MODEL: AllowedModel = "claude-fable-5";

/**
 * Optional per-deployment Slack emoji shortcodes (with colons, e.g.
 * ":acme-bot-fast:") that trigger the same tiers as the phrases below.
 * Configured in config/emojis.yaml — kept out of this file since it's
 * synced to the public template repo and the emoji names are company-specific.
 */
export interface ModeTriggerEmojis {
  fast?: string;
  thinkHardest?: string;
  think?: string;
}

// First match wins. Longer phrases before shorter ones they contain
// (e.g. "think harder" before "think hard") to avoid substring collisions.
const MODE_TIERS: {
  emojiKey: keyof ModeTriggerEmojis;
  triggers: string[];
  mode: RequestMode;
}[] = [
  {
    emojiKey: "fast",
    triggers: ["think fast"],
    mode: { model: HAIKU_MODEL },
  },
  {
    emojiKey: "thinkHardest",
    triggers: [
      "think hardest",
      "try hardest",
      "think harder",
      "try harder",
      "think dangerously",
    ],
    mode: { model: FABLE_MODEL, effort: "max" },
  },
  {
    emojiKey: "think",
    triggers: ["think hard", "try hard"],
    mode: { effort: "max" },
  },
];

const getCapabilities = (model: ModelSetting | undefined) => {
  if (!model) return getAnthropicModelCapabilities();
  const modelRef =
    typeof model === "string" ? tryParseModelRef(model) : (model as ModelRef);
  if (!modelRef) return getAnthropicModelCapabilities();
  return modelRef.provider === "openai"
    ? getOpenAIModelCapabilities(modelRef)
    : getAnthropicModelCapabilities(modelRef);
};

const supportsEffort = (
  model: ModelSetting | undefined,
  effort: EffortLevel,
): boolean => getCapabilities(model).reasoningEfforts.has(effort);

const supportsFastMode = (model: ModelSetting | undefined): boolean =>
  getCapabilities(model).supportsFastMode;

export const resolveMode = (
  text: string | undefined,
  channelMode: ChannelModeConfig | undefined,
  explicitMention?: boolean,
  modeTriggerEmojis?: ModeTriggerEmojis,
): RequestMode => {
  const lower = (text || "").toLowerCase();

  const matched = MODE_TIERS.find(tier => {
    const emoji = modeTriggerEmojis?.[tier.emojiKey];
    return (
      tier.triggers.some(t => lower.includes(t)) ||
      (!!emoji && lower.includes(emoji.toLowerCase()))
    );
  });

  // Channel model strings come from operator-edited YAML and are never
  // validated on load. Drop an unparseable value and fall back to the
  // deployment default, matching how the fastModePattern branch below fails
  // open — otherwise one bad channel entry sends every message in that channel
  // to the generic error path.
  const configuredModel = channelMode?.model;
  const channelModel =
    typeof configuredModel === "string" && !tryParseModelRef(configuredModel)
      ? undefined
      : configuredModel;
  const channelProvider =
    typeof channelModel === "string"
      ? tryParseModelRef(channelModel)?.provider
      : channelModel?.provider;
  const matchedModel = matched?.mode.model;
  // Phrase/emoji tiers predate provider routing and their unqualified model
  // aliases are Anthropic-specific. Preserve an explicitly selected OpenAI
  // model instead of silently switching paid providers.
  let model =
    channelProvider === "openai" && typeof matchedModel === "string"
      ? channelModel
      : (matchedModel ?? channelModel);
  let effort = matched?.mode.effort ?? channelMode?.effort;
  // Either condition independently enables fast mode (OR, not AND).
  let patternMatch = false;
  if (channelMode?.fastModePattern) {
    try {
      patternMatch = new RegExp(channelMode.fastModePattern, "i").test(
        text || "",
      );
    } catch {
      // Invalid regex in config — fail open (no fast mode) rather than crashing.
    }
  }
  let fast = (channelMode?.fastModeTagBot && explicitMention) || patternMatch;

  // When a trigger only sets effort (no model), release a channel Haiku pin
  // so the effort can actually take effect.
  if (
    matched &&
    !matched.mode.model &&
    effort &&
    !supportsEffort(model, effort)
  ) {
    model = undefined;
  }
  if (effort && !supportsEffort(model, effort)) effort = undefined;
  if (!supportsFastMode(model)) fast = false;

  return {
    ...(model && { model }),
    ...(effort && { effort }),
    ...(fast && { fast: true }),
  };
};
