import type { AgentUsage } from "./events";
import type { ModelRef } from "./model";

export interface TextClassifierRequest {
  model: ModelRef;
  signal: AbortSignal;
}

export interface TextClassifierResult {
  text: string;
  usage?: AgentUsage;
  costUsd?: number;
}

export interface TextClassifierBackend {
  classify(
    input: string,
    options: TextClassifierRequest & { tools: never[]; continuation: false },
  ): Promise<TextClassifierResult>;
}

export interface TextClassifier {
  classify(
    input: string,
    options: TextClassifierRequest,
  ): Promise<TextClassifierResult>;
}

/** Provider-neutral one-shot classifier boundary; callers decide fail-closed behavior. */
export class ProviderTextClassifier implements TextClassifier {
  constructor(
    private readonly backend: TextClassifierBackend,
    private readonly model?: ModelRef,
  ) {}

  classify(input: string, options: TextClassifierRequest): Promise<TextClassifierResult> {
    return this.backend.classify(input, {
      ...options,
      ...(this.model ? { model: this.model } : {}),
      tools: [],
      continuation: false,
    });
  }
}
