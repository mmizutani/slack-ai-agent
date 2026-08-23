import { config } from "../../config";
import type {
  TextClassifierBackend,
  TextClassifierRequest,
  TextClassifierResult,
} from "../../agent/text-classifier";
import { HAIKU_MODEL } from "../../request-mode";
import { buildSanitizedEnv } from "../../claude-handler";

export interface AnthropicClassifierQueryOptions {
  prompt: string;
  abortController: AbortController;
  options: Record<string, unknown>;
}

export type AnthropicClassifierQuery = (
  options: AnthropicClassifierQueryOptions,
) => AsyncIterable<any> | Promise<AsyncIterable<any>>;

async function defaultQuery(
  options: AnthropicClassifierQueryOptions,
): Promise<AsyncIterable<any>> {
  // Keep the ESM-only provider SDK inside its provider adapter.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore – eval is intentional so the shared classifier stays provider-neutral
  const { query } = await eval(
    'import("@anthropic-ai/claude-agent-sdk")',
  );
  return query(options);
}

/** One-turn Anthropic classifier backend with no tools or session continuation. */
export class AnthropicTextClassifierBackend implements TextClassifierBackend {
  constructor(private readonly query: AnthropicClassifierQuery = defaultQuery) {}

  async classify(
    input: string,
    options: TextClassifierRequest & { tools: never[]; continuation: false },
  ): Promise<TextClassifierResult> {
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
    try {
      const generator = await this.query({
        prompt: input,
        abortController,
        options: {
          model: options.model.model || HAIKU_MODEL,
          verbose: false,
          logLevel: "error",
          env: buildSanitizedEnv(config.baseDirectory),
          allowedTools: [],
          settingSources: [],
          maxTurns: 1,
          cwd: config.baseDirectory,
        },
      });
      let text = "";
      let costUsd: number | undefined;
      for await (const message of generator) {
        if (message.type === "result") {
          text = message.result || message.message?.result || text;
          costUsd = message.total_cost_usd ?? costUsd;
        } else if (message.type === "assistant") {
          const candidate = (message.message?.content || [])
            .filter((part: any) => part.type === "text")
            .map((part: any) => part.text)
            .join("");
          if (candidate) text = candidate;
        }
      }
      return { text, costUsd };
    } finally {
      options.signal.removeEventListener("abort", abort);
    }
  }
}
