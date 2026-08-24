import { expect, type Cycle } from "../lib/cycle";

/**
 * A stdio MCP server's tool is discovered and invoked.
 *
 * The fixture server returns MCP-OK-<code> for a code the model is given, so
 * the response cannot be produced without actually calling the tool: the model
 * has no way to know the MCP-OK- convention from the prompt.
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

    return { evidence: `reply ${reply.ts}` };
  },
};
