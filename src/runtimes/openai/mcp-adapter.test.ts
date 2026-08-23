import type { ResolvedMcpServerDefinition } from "../../mcp/types";
import { AgentConfigurationError } from "../../agent/errors";
import { resolveMcpServers } from "../../mcp/resolver";
import { buildOpenAIMcpServers } from "./mcp-adapter";

describe("OpenAI MCP adapter", () => {
  it("selects stdio and Streamable HTTP classes and filters tools by canonical identity", async () => {
    const stdio = jest.fn((options: unknown) => ({
      kind: "stdio",
      options,
      close: jest.fn().mockResolvedValue(undefined),
    }));
    const http = jest.fn((options: unknown) => ({
      kind: "http",
      options,
      close: jest.fn().mockResolvedValue(undefined),
    }));
    const definitions: ResolvedMcpServerDefinition[] = [
      { name: "local", transport: "stdio", command: "worker", args: ["--once"] },
      {
        name: "github",
        transport: "streamable_http",
        url: "https://mcp.example.test",
        headers: { Authorization: "Bearer redacted" },
      },
    ];

    const bundle = buildOpenAIMcpServers(definitions, {
      allowed: ["mcp:github/get_file_contents"],
      denied: [],
    }, { stdio, streamableHttp: http } as any);

    expect(bundle.servers).toHaveLength(2);
    expect(stdio).toHaveBeenCalledWith(expect.objectContaining({
      name: "local",
      command: "worker",
      args: ["--once"],
    }));
    expect(http).toHaveBeenCalledWith(expect.objectContaining({
      name: "github",
      url: "https://mcp.example.test",
      requestInit: { headers: { Authorization: "Bearer redacted" } },
      toolFilter: expect.any(Function),
    }));

    const httpOptions = http.mock.calls[0]?.[0] as any;
    expect(await httpOptions.toolFilter({}, { name: "get_file_contents" })).toBe(true);
    expect(await httpOptions.toolFilter({}, { name: "delete_repo" })).toBe(false);
  });

  it("fails closed for legacy SSE instead of silently changing transport", () => {
    expect(() =>
      buildOpenAIMcpServers([
        {
          name: "legacy",
          transport: "sse",
          url: "https://mcp.example.test/sse",
          legacy: true,
        },
      ], { allowed: [], denied: [] }),
    ).toThrow(AgentConfigurationError);
  });

  it("closes every request-scoped MCP server", async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const bundle = buildOpenAIMcpServers([
      { name: "local", transport: "stdio", command: "worker" },
    ], { allowed: [], denied: [] }, {
      stdio: jest.fn(() => ({ close })),
    } as any);

    await bundle.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("passes resolver-produced dynamic headers to Streamable HTTP", async () => {
    const [definition] = await resolveMcpServers(
      {
        internal: {
          type: "http",
          url: "https://mcp.example.test",
          headersHelper: `printf '%s' '{"Authorization":"Bearer dynamic"}'`,
        },
      },
      undefined,
    );
    const http = jest.fn((options: unknown) => ({
      options,
      close: jest.fn().mockResolvedValue(undefined),
    }));

    buildOpenAIMcpServers(
      [definition],
      { allowed: [], denied: [] },
      { stdio: jest.fn(), streamableHttp: http } as any,
    );

    expect(http).toHaveBeenCalledWith(
      expect.objectContaining({
        requestInit: { headers: { Authorization: "Bearer dynamic" } },
      }),
    );
  });
});
