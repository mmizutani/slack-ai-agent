import {
  MCPServerSSE,
  MCPServerStdio,
  MCPServerStreamableHttp,
  type MCPServer,
  type MCPToolFilterCallable,
} from "@openai/agents";
import type { EffectiveToolPolicy } from "../../mcp/permissions";
import type { ResolvedMcpServerDefinition } from "../../mcp/types";

// Take each factory's option type straight from the SDK constructor so a typo
// in command/args/env/url/name or a wrong toolFilter shape fails to compile.
// requestInit is still typed `any` in @openai/agents 0.17.0.
type StdioOptions = ConstructorParameters<typeof MCPServerStdio>[0];
type StreamableHttpOptions = ConstructorParameters<
  typeof MCPServerStreamableHttp
>[0];
type SSEOptions = ConstructorParameters<typeof MCPServerSSE>[0];

interface OpenAIMcpFactories {
  stdio(options: StdioOptions): MCPServer;
  streamableHttp(options: StreamableHttpOptions): MCPServer;
  sse(options: SSEOptions): MCPServer;
}

const defaultFactories: OpenAIMcpFactories = {
  stdio: options => new MCPServerStdio(options),
  streamableHttp: options => new MCPServerStreamableHttp(options),
  sse: options => new MCPServerSSE(options),
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
): MCPToolFilterCallable {
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
        servers.push(
          factories.sse({
            name: definition.name,
            url: definition.url,
            ...(definition.headers && {
              requestInit: { headers: definition.headers },
            }),
            toolFilter: filter,
          }),
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
