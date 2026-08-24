import { toClaudeSubagentDefinitions } from "./subagent-adapter";

describe("Claude subagent adapter", () => {
  it("intersects requested tools with the parent policy", () => {
    expect(
      toClaudeSubagentDefinitions(
        [
          {
            name: "validator",
            description: "Validate",
            instructions: "Validate the answer",
            model: { provider: "anthropic", model: "claude-haiku-4-5" },
            tools: ["Read", "Bash"],
            maxTurns: 3,
          },
        ],
        ["Read"],
        ["Bash"],
      ),
    ).toEqual({
      validator: {
        description: "Validate",
        prompt: "Validate the answer",
        model: "claude-haiku-4-5",
        tools: ["Read"],
        disallowedTools: ["Bash"],
        maxTurns: 3,
      },
    });
  });

  // A subagent YAML file may declare an OpenAI model. Passing that name to
  // Claude produces a provider rejection at run time; the OpenAI adapter guards
  // the mirror-image case in modelFor.
  it("ignores a non-Anthropic model and keeps the Claude default", () => {
    expect(
      toClaudeSubagentDefinitions(
        [
          {
            name: "validator",
            description: "Validate",
            instructions: "Validate the answer",
            model: { provider: "openai", model: "gpt-5.6-luna" },
          },
        ],
        [],
      ).validator.model,
    ).toBe("sonnet");
  });

  it("keeps an Anthropic model from the definition", () => {
    expect(
      toClaudeSubagentDefinitions(
        [
          {
            name: "validator",
            description: "Validate",
            instructions: "Validate the answer",
            model: { provider: "anthropic", model: "claude-haiku-4-5" },
          },
        ],
        [],
      ).validator.model,
    ).toBe("claude-haiku-4-5");
  });
});
