import dotenv from "dotenv";
import { Agent, OpenAIProvider, Runner, tool } from "@openai/agents";
import { z } from "zod";
import { resolveOpenAIModel } from "../src/runtimes/openai/model-config";

dotenv.config({ quiet: true });

const MODEL = resolveOpenAIModel();
// Mirror the runtime rule in src/config.ts. Deployments that opt out of
// Responses storage must not have the smoke check silently store transcripts.
const STORE_RESPONSES = process.env.OPENAI_STORE_RESPONSES !== "false";

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OpenAI smoke blocked: OPENAI_API_KEY is not configured");
    process.exitCode = 2;
    return;
  }

  const provider = new OpenAIProvider({
    apiKey,
    ...(process.env.OPENAI_BASE_URL && {
      baseURL: process.env.OPENAI_BASE_URL,
    }),
    ...(process.env.OPENAI_ORGANIZATION && {
      organization: process.env.OPENAI_ORGANIZATION,
    }),
    ...(process.env.OPENAI_PROJECT && { project: process.env.OPENAI_PROJECT }),
    useResponses: true,
  });
  const runner = new Runner({
    modelProvider: provider,
    tracingDisabled: true,
    traceIncludeSensitiveData: false,
  });

  try {
    const textResult = await runner.run(
      new Agent({
        name: "openai-smoke-text",
        instructions: "Reply with a short confirmation.",
        model: MODEL,
        modelSettings: { store: STORE_RESPONSES },
        tools: [],
      }),
      "Return a short smoke-test confirmation.",
      { maxTurns: 1 },
    );
    if (
      typeof textResult.finalOutput !== "string" ||
      !textResult.finalOutput.trim()
    ) {
      throw new Error("text response was empty");
    }

    let invoked = false;
    const add = tool({
      name: "smoke_add",
      description: "Add two integers for the deterministic smoke check.",
      parameters: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => {
        // Assert the arguments too: invocation alone would pass even if the
        // model called the tool with the wrong operands.
        if (a !== 2 || b !== 3) {
          throw new Error("smoke_add received unexpected arguments");
        }
        invoked = true;
        return String(a + b);
      },
    });
    const toolResult = await runner.run(
      new Agent({
        name: "openai-smoke-tool",
        instructions:
          "Call smoke_add with a=2 and b=3, then reply with exactly TOOL_OK.",
        model: MODEL,
        modelSettings: { toolChoice: "required", store: STORE_RESPONSES },
        tools: [add],
      }),
      "Run the deterministic function-tool check.",
      { maxTurns: 2 },
    );
    if (!invoked || toolResult.finalOutput !== "TOOL_OK") {
      throw new Error("deterministic function-tool check did not complete");
    }

    console.log(
      "OpenAI smoke passed: text and deterministic function-tool modes",
    );
  } catch (error) {
    // Do not print provider messages: gateways may include request details.
    console.error(
      "OpenAI smoke blocked or failed:",
      error instanceof Error ? error.name : "unknown error",
    );
    process.exitCode = 1;
  } finally {
    await provider.close();
  }
}

void main();
