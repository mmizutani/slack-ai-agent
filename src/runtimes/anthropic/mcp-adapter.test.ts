import { toClaudeMcpServers } from "./mcp-adapter";

describe("Anthropic MCP adapter", () => {
  it("maps canonical transports back to Claude-compatible definitions", () => {
    expect(
      toClaudeMcpServers([
        {
          name: "local",
          transport: "stdio",
          command: "node",
          args: ["server.js"],
        },
        {
          name: "remote",
          transport: "streamable_http",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer token" },
        },
      ]),
    ).toEqual({
      local: { type: "stdio", command: "node", args: ["server.js"] },
      remote: {
        type: "http",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer token" },
      },
    });
  });
});
