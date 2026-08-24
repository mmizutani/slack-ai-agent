import {
  McpServerConfig,
  McpConfiguration,
} from "../../mcp-manager";
import { ResolvedMcpServerDefinition } from "../../mcp/types";

/** Convert canonical request-scoped definitions to Claude SDK input. */
export function toClaudeMcpServers(
  definitions: ResolvedMcpServerDefinition[],
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  for (const definition of definitions) {
    if (definition.transport === "stdio") {
      servers[definition.name] = {
        type: "stdio",
        command: definition.command,
        ...(definition.args ? { args: definition.args } : {}),
        ...(definition.env ? { env: definition.env } : {}),
      };
      continue;
    }
    servers[definition.name] = {
      type: definition.transport === "sse" ? "sse" : "http",
      url: definition.url,
      ...(definition.headers ? { headers: definition.headers } : {}),
    } as McpServerConfig;
  }
  return servers;
}

export function toClaudeMcpConfiguration(
  definitions: ResolvedMcpServerDefinition[],
): McpConfiguration {
  return { mcpServers: toClaudeMcpServers(definitions) };
}
