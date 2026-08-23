import { Agent, type Runner } from "@openai/agents";
import type {
  TextClassifierBackend,
  TextClassifierRequest,
  TextClassifierResult,
} from "../../agent/text-classifier";
import { config } from "../../config";
import { adaptOpenAIStream } from "./event-adapter";
import { createOpenAIRunner, createOpenAIProvider } from "./provider";

export interface OpenAITextClassifierOptions {
  runner?: Pick<Runner, "run">;
  apiKey?: string;
  baseUrl?: string;
}

/** One-turn OpenAI classifier backend with no tools or session continuation. */
export class OpenAITextClassifierBackend implements TextClassifierBackend {
  private readonly runner: Pick<Runner, "run">;

  constructor(options: OpenAITextClassifierOptions = {}) {
    this.runner =
      options.runner ??
      createOpenAIRunner(
        createOpenAIProvider({
          apiKey: options.apiKey ?? config.openai.apiKey,
          baseUrl: options.baseUrl ?? config.openai.baseUrl,
        }),
        false,
      );
  }

  async classify(
    input: string,
    options: TextClassifierRequest & { tools: never[]; continuation: false },
  ): Promise<TextClassifierResult> {
    const agent = new Agent({
      name: "slack-smart-reply-classifier",
      instructions:
        "Classify the input according to the caller's instructions and return only the requested answer.",
      model: options.model.model,
      tools: [],
    });
    const stream = await this.runner.run(agent, input, {
      stream: true,
      signal: options.signal,
      maxTurns: 1,
    } as any);

    let text = "";
    let usage: TextClassifierResult["usage"];
    let failure: string | undefined;
    for await (const event of adaptOpenAIStream(stream as any, {
      signal: options.signal,
      result: stream as any,
    })) {
      if (event.type === "text_delta") text += event.text;
      if (event.type === "usage") usage = event.usage;
      if (event.type === "terminal" && event.outcome !== "completed") {
        failure = event.reason || event.outcome;
      }
    }
    if (failure) throw new Error(`OpenAI classifier failed: ${failure}`);
    if (!text && typeof (stream as any).finalOutput === "string") {
      text = (stream as any).finalOutput;
    }
    return { text, usage };
  }
}
