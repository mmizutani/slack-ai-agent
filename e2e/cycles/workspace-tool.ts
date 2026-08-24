import { expect, type Cycle } from "../lib/cycle";

/**
 * The bounded workspace file tools actually execute.
 *
 * A file is seeded into data/, which provisionThreadWorkspace copies into every
 * per-thread agent workspace. Its contents are a value the model has never
 * seen, so echoing it proves a read happened; the tool-call count from the
 * tracking log confirms a tool ran rather than the model guessing.
 */
export const workspaceTool: Cycle = {
  id: "workspace-tool",
  describe: "the agent reads a file from its workspace",
  async run(ctx) {
    const fixtures = ctx.fixtures;
    expect(fixtures !== undefined, "workspace fixtures were not installed");

    const expected = fixtures.workspaceFileContent.trim();
    const rootTs = await ctx.say(
      `Read the file ${fixtures.workspaceFileRelPath} in your working directory and reply with its exact contents and nothing else.`,
    );

    const reply = await ctx.awaitBotReply({
      channel: ctx.config.channelId,
      rootTs,
      match: message => (message.text ?? "").includes(expected),
    });

    const toolCalls = /"toolCalls":(\d+)/.exec(ctx.logsSinceStart());
    expect(
      toolCalls !== null && Number(toolCalls[1]) > 0,
      "the reply contained the file's contents but the app recorded no tool " +
        "calls, so the value did not come from reading the file",
    );

    return { evidence: `reply ${reply.ts}; toolCalls=${toolCalls?.[1]}` };
  },
};
