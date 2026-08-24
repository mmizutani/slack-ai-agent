import { config } from "./config";
import { HAIKU_MODEL } from "./request-mode";
import { Logger } from "./logger";
import type { ModelRef } from "./agent/model";
import {
  ProviderTextClassifier,
  type TextClassifier,
} from "./agent/text-classifier";
import { AnthropicTextClassifierBackend } from "./runtimes/anthropic/text-classifier";
import { OpenAITextClassifierBackend } from "./runtimes/openai/text-classifier";

const logger = new Logger("SmartReplyFilter");

/** Messages shorter than this (whitespace collapsed) are dropped. Kept small so
 *  short but genuine questions like "what is 5*0" still reach the classifier. */
export const SMART_REPLY_MIN_TEXT_LENGTH = 8;
/** Minimum number of "real" words required to bother classifying. */
export const SMART_REPLY_MIN_WORDS = 2;
/** Upper bound on how long we let the cheap classifier run before giving up. */
export const SMART_REPLY_CLASSIFIER_TIMEOUT_MS = 12000;

/**
 * Layer 1 — free structural pre-filter. Cheaply rejects messages that clearly
 * aren't worth a classifier call (empty or tiny) before we spend any tokens.
 * Returns true when the message is worth classifying.
 *
 * We deliberately measure the raw message (only collapsing whitespace) and do
 * NOT strip mentions, links, or code: that content is often the substance of a
 * help request — a pasted error inside a code block, or "how do I use <link>?"
 * — and stripping it here would shrink real questions below the threshold and
 * hide them from the classifier. Borderline cases are left for the classifier.
 */
export const passesSmartReplyStructuralFilter = (
  text: string | undefined,
): boolean => {
  if (!text) return false;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  // A question mark is a strong signal of a genuine ask, so let even short
  // questions through to the classifier (e.g. "What is 5*0?"), which the
  // length/word bar below would otherwise drop.
  if (normalized.includes("?")) return true;
  if (normalized.length < SMART_REPLY_MIN_TEXT_LENGTH) return false;
  const words = normalized.split(" ").filter(Boolean);
  return words.length >= SMART_REPLY_MIN_WORDS;
};

const CLASSIFIER_INSTRUCTIONS = `You are a fast routing gate for a Slack assistant bot. The bot is a broadly capable assistant: beyond engineering topics (code, infrastructure, data, internal tools, documentation) it can answer general-knowledge and factual questions, do math and calculations, and help with company/HR/policy questions (e.g. benefits, peer bonuses, time off and holidays). It can also take actions like opening a PR, filing a ticket, or looking things up.

You are shown one Slack message. Decide whether the bot could plausibly HELP with it:
- YES if it is ANY question the bot could answer — technical, general-knowledge, factual, math/calculation, or company/HR/policy — or an actionable request the bot could perform or propose.
- NO only for messages that need no assistant action: social chatter, greetings, acknowledgements, reactions, status updates, announcements/FYIs, jokes, or messages clearly aimed at a specific person.

When unsure, lean YES for anything phrased as a genuine question — a later full check still stays silent if the bot truly can't help, but a wrongly-dropped question can never be answered.

Answer with exactly one word: YES or NO.`;

/** Build the one-shot classifier prompt for a candidate message. */
export const buildClassifierPrompt = (text: string): string =>
  `${CLASSIFIER_INSTRUCTIONS}\n\n---\nMessage:\n"""\n${text}\n"""\n\nAnswer (YES or NO):`;

/**
 * Parse the classifier's free-text output into a boolean decision. Fail-closed:
 * anything that isn't a clear YES is treated as NO.
 */
export const parseClassifierDecision = (raw: string | undefined): boolean => {
  if (!raw) return false;
  // Take the first alphabetic token so trailing punctuation/markdown is ignored.
  const match = raw
    .trim()
    .toUpperCase()
    .match(/[A-Z]+/);
  return match?.[0] === "YES";
};

function configuredClassifierModel(): ModelRef {
  if (config.smartReplyModel) return config.smartReplyModel;
  if (config.agent.defaultProvider === "openai") {
    return {
      provider: "openai",
      model: config.openai.model || "gpt-5.6-luna",
    };
  }
  return { provider: "anthropic", model: HAIKU_MODEL };
}

/** Build the selected provider's cheap, tools-off classifier lazily. */
export function createConfiguredTextClassifier(
  model: ModelRef = configuredClassifierModel(),
): TextClassifier {
  return new ProviderTextClassifier(
    model.provider === "openai"
      ? new OpenAITextClassifierBackend()
      : new AnthropicTextClassifierBackend(),
    model,
  );
}

/** Result of the smart-reply classifier: the decision plus provider-reported
 *  spend (USD), so callers can track the cost even when the answer is NO. */
export interface SmartReplyClassification {
  couldHelp: boolean;
  costUsd?: number;
}

/**
 * Layer 2 — cheap provider classifier. `couldHelp` is true only when the model
 * judges the message to be something the bot could help with; it fails closed
 * (false) on timeout or error so smart reply never becomes a source of noise.
 * `costUsd` is the classifier's spend, reported regardless of decision — but
 * only the backends that report a cost populate it (Anthropic does; the OpenAI
 * backend returns token usage instead), so treat it as optional.
 */
export const classifySmartReplyCandidate = async (
  text: string,
  classifier: TextClassifier = createConfiguredTextClassifier(),
): Promise<SmartReplyClassification> => {
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(),
    SMART_REPLY_CLASSIFIER_TIMEOUT_MS,
  );
  try {
    // No model is passed: the classifier carries its own provider/model pair.
    // Supplying the globally configured one here would override an injected
    // classifier with a model from a different provider.
    const { text: raw, costUsd } = await classifier.classify(
      buildClassifierPrompt(text),
      { signal: abortController.signal },
    );
    const decision = parseClassifierDecision(raw);
    logger.debug("Smart-reply classifier decision", {
      decision: decision ? "YES" : "NO",
      textLength: text.length,
      costUsd,
    });
    return { couldHelp: decision, costUsd };
  } catch (error) {
    logger.warn("Smart-reply classifier failed; staying silent", { error });
    return { couldHelp: false };
  } finally {
    clearTimeout(timeout);
  }
};
