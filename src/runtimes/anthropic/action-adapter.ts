import type { ActionToolDefinition } from "../../custom-actions/tool-definitions";

interface ClaudeActionFactories {
  tool(
    name: string,
    description: string,
    inputSchema: Record<string, any>,
    handler: (args: unknown) => Promise<unknown>,
  ): unknown;
  createSdkMcpServer(options: { name: string; tools: unknown[] }): unknown;
}

/** Build Claude's in-process MCP representation without leaking it to core. */
export async function buildClaudeActionMcpServers(
  definitions: readonly ActionToolDefinition[],
  factories?: ClaudeActionFactories,
): Promise<Record<string, unknown>> {
  const sdk =
    factories ??
    (await (async () => {
      const imported = await eval(
        'import("@anthropic-ai/claude-agent-sdk")',
      );
      return imported as ClaudeActionFactories;
    })());

  const byServer = new Map<string, ActionToolDefinition[]>();
  for (const definition of definitions) {
    const server = definition.identity.server ?? "custom-actions";
    const bucket = byServer.get(server) ?? [];
    bucket.push(definition);
    byServer.set(server, bucket);
  }

  const servers: Record<string, unknown> = {};
  for (const [server, serverDefinitions] of byServer) {
    const tools = serverDefinitions.map(definition =>
      sdk.tool(
        definition.name,
        definition.description,
        definition.inputSchema,
        async args => {
          const result = await definition.invoke(args);
          return {
            content: result.text
              ? [{ type: "text", text: result.text }]
              : [],
            ...(result.isError !== undefined && { isError: result.isError }),
            ...(result.suppressReply || result.confirmationDialogPosted
              ? {
                  structuredContent: {
                    ...(result.suppressReply && { suppressReply: true }),
                    ...(result.confirmationDialogPosted && {
                      confirmationDialogPosted: true,
                    }),
                  },
                }
              : {}),
          };
        },
      ),
    );
    servers[server] = sdk.createSdkMcpServer({ name: server, tools });
  }
  return servers;
}
