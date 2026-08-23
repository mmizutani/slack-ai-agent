import { resolveMcpServers } from "./resolver";

describe("resolveMcpServers", () => {
  it("normalizes transports and binds trusted identity headers", async () => {
    const resolved = await resolveMcpServers(
      {
        github: {
          type: "http",
          url: "https://github.example/mcp",
          headers: { Authorization: "Bearer token" },
          userEmailHeader: "X-User-Email",
        },
        local: { command: "node", args: ["server.js"] },
      },
      { email: "user@example.com" },
    );

    expect(resolved).toEqual([
      {
        name: "github",
        transport: "streamable_http",
        url: "https://github.example/mcp",
        headers: {
          Authorization: "Bearer token",
          "X-User-Email": "user@example.com",
        },
      },
      {
        name: "local",
        transport: "stdio",
        command: "node",
        args: ["server.js"],
      },
    ]);
  });

  it("omits identity-bound servers when a human identity is unavailable", async () => {
    const resolved = await resolveMcpServers(
      {
        identity: {
          type: "sse",
          url: "https://identity.example/mcp",
          userEmailHeader: "X-User-Email",
        },
        plain: { type: "http", url: "https://plain.example/mcp" },
      },
      undefined,
    );

    expect(resolved.map(server => server.name)).toEqual(["plain"]);
  });

  it("executes a trusted headers helper and lets requester identity win", async () => {
    const resolved = await resolveMcpServers(
      {
        github: {
          type: "http",
          url: "https://github.example/mcp",
          headers: { "X-Static": "static", "X-User-Email": "stale" },
          headersHelper: `printf '%s' '{"X-Dynamic":"dynamic","X-User-Email":"untrusted"}'`,
          userEmailHeader: "X-User-Email",
        },
      },
      { email: "user@example.com" },
    );

    expect(resolved).toEqual([
      {
        name: "github",
        transport: "streamable_http",
        url: "https://github.example/mcp",
        headers: {
          "X-Static": "static",
          "X-Dynamic": "dynamic",
          "X-User-Email": "user@example.com",
        },
      },
    ]);
  });

  it("executes a trusted headers helper for legacy SSE transport", async () => {
    const resolved = await resolveMcpServers(
      {
        legacy: {
          type: "sse",
          url: "https://legacy.example/mcp",
          headersHelper: `printf '%s' '{"Authorization":"Bearer dynamic"}'`,
        },
      },
      undefined,
    );

    expect(resolved).toEqual([{
      name: "legacy",
      transport: "sse",
      url: "https://legacy.example/mcp",
      headers: { Authorization: "Bearer dynamic" },
      legacy: true,
    }]);
  });

  it("does not expose application provider credentials to headers helpers", async () => {
    const original = process.env.SLACK_AI_AGENT_SECRET_SENTINEL;
    process.env.SLACK_AI_AGENT_SECRET_SENTINEL = "must-not-be-inherited";
    try {
      const resolved = await resolveMcpServers(
        {
          safe: {
            type: "http",
            url: "https://safe.example/mcp",
            headersHelper:
              `printf '{"Inherited":"%s"}' "\${SLACK_AI_AGENT_SECRET_SENTINEL-unset}"`,
          },
        },
        undefined,
      );

      expect(resolved[0]).toEqual(expect.objectContaining({
        headers: { Inherited: "unset" },
      }));
    } finally {
      if (original === undefined) {
        delete process.env.SLACK_AI_AGENT_SECRET_SENTINEL;
      } else {
        process.env.SLACK_AI_AGENT_SECRET_SENTINEL = original;
      }
    }
  });

  it("omits a server when its dynamic headers helper fails closed", async () => {
    const resolved = await resolveMcpServers(
      {
        broken: {
          type: "http",
          url: "https://broken.example/mcp",
          headersHelper: "printf '%s' 'not-json'",
        },
        plain: {
          type: "http",
          url: "https://plain.example/mcp",
        },
      },
      undefined,
    );

    expect(resolved.map(server => server.name)).toEqual(["plain"]);
  });
});
