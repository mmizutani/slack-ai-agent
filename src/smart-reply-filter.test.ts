import {
  passesSmartReplyStructuralFilter,
  buildClassifierPrompt,
  parseClassifierDecision,
  classifySmartReplyCandidate,
  createConfiguredTextClassifier,
} from "./smart-reply-filter";
import type { TextClassifierBackend } from "./agent/text-classifier";
import { ProviderTextClassifier } from "./agent/text-classifier";

describe("passesSmartReplyStructuralFilter", () => {
  it("rejects undefined and empty text", () => {
    expect(passesSmartReplyStructuralFilter(undefined)).toBe(false);
    expect(passesSmartReplyStructuralFilter("")).toBe(false);
    expect(passesSmartReplyStructuralFilter("   ")).toBe(false);
  });

  it("rejects very short chatter", () => {
    expect(passesSmartReplyStructuralFilter("thanks!")).toBe(false);
    expect(passesSmartReplyStructuralFilter("lgtm")).toBe(false);
  });

  it("accepts a short question so the classifier can weigh in", () => {
    expect(passesSmartReplyStructuralFilter("What is 5*0?")).toBe(true);
    // Even without a question mark, a short genuine ask clears the lowered bar.
    expect(passesSmartReplyStructuralFilter("what is 5*0")).toBe(true);
  });

  it("accepts a substantive question", () => {
    expect(
      passesSmartReplyStructuralFilter(
        "why is the prod deploy failing on the migration step?",
      ),
    ).toBe(true);
  });

  it("accepts an actionable request even without a question mark", () => {
    expect(
      passesSmartReplyStructuralFilter(
        "can someone make a PR to add a comment in this file",
      ),
    ).toBe(true);
  });

  it("does not strip markup: a pasted error in a code block is kept for the classifier", () => {
    expect(
      passesSmartReplyStructuralFilter(
        "```\nTypeError: Cannot read properties of undefined (reading 'id')\n```",
      ),
    ).toBe(true);
  });

  it("keeps a request whose substance is a link", () => {
    expect(
      passesSmartReplyStructuralFilter(
        "how do i use <https://example.com/docs|this api> here",
      ),
    ).toBe(true);
  });

  it("accepts a normal request that happens to lead with a mention", () => {
    expect(
      passesSmartReplyStructuralFilter(
        "<@user> can you look at the failing build please",
      ),
    ).toBe(true);
  });
});

describe("parseClassifierDecision", () => {
  it("treats a clean YES as help", () => {
    expect(parseClassifierDecision("YES")).toBe(true);
    expect(parseClassifierDecision(" yes ")).toBe(true);
  });

  it("ignores trailing punctuation and markdown around YES", () => {
    expect(parseClassifierDecision("YES.")).toBe(true);
    expect(parseClassifierDecision("**YES**")).toBe(true);
  });

  it("treats NO and anything ambiguous as no help", () => {
    expect(parseClassifierDecision("NO")).toBe(false);
    expect(parseClassifierDecision("no, this is chatter")).toBe(false);
    expect(parseClassifierDecision("maybe")).toBe(false);
    expect(parseClassifierDecision("")).toBe(false);
    expect(parseClassifierDecision(undefined)).toBe(false);
  });
});

describe("buildClassifierPrompt", () => {
  it("embeds the candidate message and asks for a YES/NO answer", () => {
    const prompt = buildClassifierPrompt("can someone open a PR for me");
    expect(prompt).toContain("can someone open a PR for me");
    expect(prompt).toContain("YES or NO");
  });
});

describe("provider-neutral classifier", () => {
  it("selects an OpenAI backend for an OpenAI classifier model", () => {
    const classifier = createConfiguredTextClassifier({
      provider: "openai",
      model: "gpt-5.6-luna",
    });

    expect(classifier.constructor.name).toBe("ProviderTextClassifier");
    expect((classifier as any).backend.constructor.name).toBe(
      "OpenAITextClassifierBackend",
    );
  });

  it("keeps the model used to select the configured backend", async () => {
    const classifier = createConfiguredTextClassifier({
      provider: "openai",
      model: "gpt-5.6-luna",
    });
    const classify = jest.fn().mockResolvedValue({ text: "YES" });
    (classifier as any).backend = { classify };

    await classifier.classify("classify me", {
      model: { provider: "anthropic", model: "claude-opus-5" },
      signal: new AbortController().signal,
    });

    expect(classify).toHaveBeenCalledWith(
      "classify me",
      expect.objectContaining({
        model: { provider: "openai", model: "gpt-5.6-luna" },
      }),
    );
  });

  it("passes a one-shot no-tool request to the selected backend", async () => {
    const classify = jest.fn().mockResolvedValue({ text: "YES" });
    const classifier = new ProviderTextClassifier({
      classify,
    } satisfies TextClassifierBackend);

    await expect(
      classifySmartReplyCandidate("can you investigate this?", classifier),
    ).resolves.toEqual({ couldHelp: true, costUsd: undefined });
    expect(classify).toHaveBeenCalledWith(
      expect.stringContaining("can you investigate this?"),
      expect.objectContaining({
        tools: [],
        continuation: false,
        signal: expect.any(AbortSignal),
      }),
    );
    // The call site must not supply a model: an injected classifier carries its
    // own provider/model pair, and overriding it can cross providers.
    expect(classify.mock.calls[0][1]).not.toHaveProperty("model");
  });

  it("lets an injected classifier keep its own model instead of the configured one", async () => {
    const classify = jest.fn().mockResolvedValue({ text: "YES" });
    const classifier = new ProviderTextClassifier(
      { classify } satisfies TextClassifierBackend,
      { provider: "anthropic", model: "claude-haiku-4-5" },
    );

    await classifySmartReplyCandidate("can you investigate this?", classifier);

    expect(classify).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        model: { provider: "anthropic", model: "claude-haiku-4-5" },
      }),
    );
  });

  it("fails closed when the provider classifier errors", async () => {
    const classifier = new ProviderTextClassifier({
      classify: jest.fn().mockRejectedValue(new Error("provider unavailable")),
    });

    await expect(
      classifySmartReplyCandidate("can you investigate this?", classifier),
    ).resolves.toEqual({ couldHelp: false });
  });
});
