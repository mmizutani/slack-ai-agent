import {
  MCPServerSSE,
  MCPServerStdio,
  MCPServerStreamableHttp,
  type MCPServer,
} from "@openai/agents";
import { AgentConfigurationError } from "../../agent/errors";
import type { EffectiveToolPolicy } from "../../mcp/permissions";
import type { ResolvedMcpServerDefinition } from "../../mcp/types";

interface OpenAIMcpFactories {
  stdio(options: Record<string, unknown>): MCPServer;
  streamableHttp(options: Record<string, unknown>): MCPServer;
  sse(options: Record<string, unknown>): MCPServer;
}

const defaultFactories: OpenAIMcpFactories = {
  stdio: options => new MCPServerStdio(options as any),
  streamableHttp: options => new MCPServerStreamableHttp(options as any),
  sse: options => new MCPServerSSE(options as any),
};

export interface OpenAIMcpBundle {
  servers: MCPServer[];
  close(): Promise<void>;
}

function canonicalToolName(server: string, name: string): string {
  return `mcp:${server}/${name}`;
}

function toolFilter(
  server: string,
  policy: Pick<EffectiveToolPolicy, "allowed" | "denied">,
): (context: unknown, tool: { name: string }) => Promise<boolean> {
  const allowed = new Set(policy.allowed ?? []);
  const denied = new Set(policy.denied ?? []);
  return async (_context, candidate) => {
    const identity = canonicalToolName(server, candidate.name);
    return allowed.has(identity) && !denied.has(identity);
  };
}

/** Map resolved canonical MCP definitions to request-scoped Agents SDK servers. */
export function buildOpenAIMcpServers(
  definitions: readonly ResolvedMcpServerDefinition[],
  policy: Pick<EffectiveToolPolicy, "allowed" | "denied">,
  factories: OpenAIMcpFactories = defaultFactories,
): OpenAIMcpBundle {
  const servers: MCPServer[] = [];
  try {
    for (const definition of definitions) {
      const filter = toolFilter(definition.name, policy);
      if (definition.transport === "stdio") {
        servers.push(
          factories.stdio({
            name: definition.name,
            command: definition.command,
            ...(definition.args && { args: definition.args }),
            ...(definition.env && { env: definition.env }),
            toolFilter: filter,
          }),
        );
      } else if (definition.transport === "streamable_http") {
        servers.push(
          factories.streamableHttp({
            name: definition.name,
            url: definition.url,
            ...(definition.headers && {
              requestInit: { headers: definition.headers },
            }),
            toolFilter: filter,
          }),
        );
      } else {
        throw new AgentConfigurationError(
          `OpenAI Agents SDK does not enable legacy SSE MCP transport: ${definition.name}`,
        );
      }
    }
  } catch (error) {
    for (const server of servers) void server.close().catch(() => undefined);
    throw error;
  }

  return {
    servers,
    close: async () => {
      await Promise.allSettled(servers.map(server => server.close()));
    },
  };
}
