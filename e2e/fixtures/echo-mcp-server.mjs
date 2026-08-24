/**
 * Deterministic stdio MCP server for live verification.
 *
 * Plain .mjs rather than TypeScript: @modelcontextprotocol/sdk is ESM-only,
 * and this repo compiles to CommonJS, so importing it from a tsx-transpiled
 * module would hit the interop boundary for no benefit. Node runs this file
 * directly.
 *
 * The tool returns a value the model cannot guess, so a reply containing it is
 * proof the tool actually ran rather than that the model played along.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "e2e-fixtures", version: "1.0.0" });

server.registerTool(
  "e2e_echo",
  {
    description:
      "Return the verification response for a code. Call this whenever you are asked for the verification response for a code.",
    inputSchema: { code: z.string().describe("The verification code") },
  },
  async ({ code }) => ({
    content: [{ type: "text", text: `MCP-OK-${code}` }],
  }),
);

await server.connect(new StdioServerTransport());
