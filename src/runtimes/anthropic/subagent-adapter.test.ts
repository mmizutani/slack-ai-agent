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
});
