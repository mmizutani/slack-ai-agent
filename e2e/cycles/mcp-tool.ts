import { expect, recordedToolCalls, type Cycle } from "../lib/cycle";

/**
 * A stdio MCP server's tool is discovered and invoked.
 *
 * The fixture server returns MCP-OK-<code> for a code the model is given. The
 * MCP-OK- convention appears nowhere in the prompt, so the reply is strong
 * evidence the tool ran — but not proof, since a model could in principle
 * produce the string. The recorded tool-call count settles it, and keeps this
 * cycle symmetric with workspace-tool, which asserted both from the start.
 */
export const mcpTool: Cycle = {
  id: "mcp-tool",
  describe: "a stdio MCP tool is invoked and its result reaches Slack",
  async run(ctx) {
    expect(ctx.fixtures !== undefined, "MCP fixtures were not installed");

    const code = ctx.marker();
    const rootTs = await ctx.say(
      `What is the verification response for code ${code}? Reply with the verification response and nothing else.`,
    );

    const reply = await ctx.awaitBotReply({
      channel: ctx.config.channelId,
      rootTs,
      match: message => (message.text ?? "").includes(`MCP-OK-${code}`),
    });

    const toolCalls = recordedToolCalls(ctx.logsSinceStart());
    expect(
      toolCalls !== undefined && toolCalls > 0,
      `the reply carried MCP-OK-${code} but the app recorded ${toolCalls ?? "no"} tool calls, so it did not come from the MCP server`,
    );

    return { evidence: `reply ${reply.ts}; toolCalls=${toolCalls}` };
  },
};
