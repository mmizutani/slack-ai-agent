import childProcess from "child_process";
import https from "https";
import net from "net";
import { promisify } from "util";

import { AnthropicTextClassifierBackend } from "../runtimes/anthropic/text-classifier";
import {
  agentCliCommandLine,
  connectTarget,
  isLoopbackHost,
  scrubProviderCredentials,
} from "./offline-guard";

/**
 * Guards the guard. Every case here is a way a unit test could otherwise reach
 * a paid provider endpoint.
 */
describe("scrubProviderCredentials", () => {
  it("overwrites a real key that is already in the environment", () => {
    // The case that matters: a developer who also runs the agent, or CI that
    // exports a key for another job, already has the real value set. Seeding
    // with `??=` would preserve exactly the value this must remove.
    const env: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: "sk-ant-api03-real-key",
      OPENAI_API_KEY: "sk-proj-real-key",
      CC_SLACK_BOT_TOKEN: "xoxb-real",
    };

    scrubProviderCredentials(env);

    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(env.OPENAI_API_KEY).toBe("sk-openai-test");
    expect(env.CC_SLACK_BOT_TOKEN).toBe("xoxb-test");
  });

  it("clears credentials and endpoint overrides that have no placeholder", () => {
    const env: NodeJS.ProcessEnv = {
      ANTHROPIC_AUTH_TOKEN: "real-oauth-token",
      ANTHROPIC_BASE_URL: "https://gateway.example.com",
      CLAUDE_CODE_OAUTH_TOKEN: "real-oauth-token",
      OPENAI_BASE_URL: "https://gateway.example.com",
    };

    scrubProviderCredentials(env);

    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });

  it("disables the Agents SDK trace exporter", () => {
    const env: NodeJS.ProcessEnv = {};
    scrubProviderCredentials(env);
    expect(env.OPENAI_AGENTS_DISABLE_TRACING).toBe("1");
  });
});

describe("connectTarget", () => {
  it("reports a remote host given raw port/host arguments", () => {
    expect(connectTarget([443, "api.anthropic.com"])).toBe(
      "api.anthropic.com:443",
    );
  });

  it("reports a remote host given an options object", () => {
    expect(connectTarget([{ host: "api.openai.com", port: 443 }])).toBe(
      "api.openai.com:443",
    );
  });

  it("unwraps the normalized argument array net.connect() passes through", () => {
    // net.connect() hands Socket.prototype.connect `[options, callback]`, not
    // its own arguments. Without unwrapping, `.host` reads as undefined, the
    // target looks like loopback, and the connection is allowed.
    const normalized = [{ host: "api.anthropic.com", port: 443 }, undefined];
    expect(connectTarget([normalized])).toBe("api.anthropic.com:443");
  });

  it("allows loopback and IPC targets", () => {
    expect(connectTarget([8080, "127.0.0.1"])).toBeUndefined();
    expect(connectTarget([{ host: "localhost", port: 8080 }])).toBeUndefined();
    expect(connectTarget(["/tmp/some.sock"])).toBeUndefined();
    expect(connectTarget([{ path: "/tmp/some.sock" }])).toBeUndefined();
  });

  it("does not mistake a remote host for loopback", () => {
    expect(isLoopbackHost("api.anthropic.com")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.evil.example")).toBe(false);
    expect(isLoopbackHost("::1")).toBe(true);
  });
});

describe("agentCliCommandLine", () => {
  it("flags the provider CLI by name, by path, and behind node", () => {
    expect(agentCliCommandLine("claude", ["-p", "hi"])).toBe("claude -p hi");
    expect(
      agentCliCommandLine(
        "/repo/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
        [],
      ),
    ).toContain("claude");
    expect(
      agentCliCommandLine("node", [
        "/repo/node_modules/@anthropic-ai/claude-agent-sdk/cli.js",
      ]),
    ).toContain("cli.js");
  });

  it("leaves the shell alone, which the MCP headers helper needs", () => {
    expect(
      agentCliCommandLine("/bin/sh", ["-c", "printf '{}'"]),
    ).toBeUndefined();
    expect(agentCliCommandLine("node", ["server.js"])).toBeUndefined();
  });
});

describe("the guard as installed by test-setup", () => {
  it("leaves only placeholder credentials in process.env", () => {
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(process.env.OPENAI_API_KEY).toBe("sk-openai-test");
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("refuses fetch to the Anthropic API", async () => {
    await expect(
      fetch("https://api.anthropic.com/v1/messages", { method: "POST" }),
    ).rejects.toThrow(/OfflineTestGuard/);
  });

  it("refuses a raw TCP connect to the Anthropic API", () => {
    expect(() => net.connect(443, "api.anthropic.com")).toThrow(
      /OfflineTestGuard/,
    );
  });

  it("refuses https.request, the path axios and the SDKs take", async () => {
    await expect(
      new Promise((_resolve, reject) => {
        try {
          const request = https.request(
            "https://api.anthropic.com/v1/messages",
          );
          request.on("error", reject);
          request.end();
        } catch (error) {
          reject(error);
        }
      }),
    ).rejects.toThrow(/OfflineTestGuard/);
  });

  it("still allows loopback so a test may stand up a local server", async () => {
    const server = net.createServer(socket => socket.end());
    try {
      const port = await new Promise<number>(resolve =>
        server.listen(0, "127.0.0.1", () =>
          resolve((server.address() as net.AddressInfo).port),
        ),
      );
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1");
        socket.on("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.on("error", reject);
      });
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it("refuses to spawn the Claude Code CLI", () => {
    expect(() => childProcess.spawn("claude", ["-p", "hello"])).toThrow(
      /OfflineTestGuard/,
    );
  });

  it("still allows /bin/sh, which the MCP headers helper needs", () => {
    const stdout = childProcess.execFileSync("/bin/sh", ["-c", "printf ok"]);
    expect(stdout.toString()).toBe("ok");
  });

  it("keeps promisify(execFile) resolving to { stdout, stderr }", async () => {
    // src/mcp/resolver.ts promisifies execFile and destructures the result.
    // A wrapper without util.promisify.custom resolves to stdout alone, which
    // breaks that caller without the guard itself ever reporting anything.
    const execFileAsync = promisify(childProcess.execFile);
    const { stdout } = await execFileAsync("/bin/sh", ["-c", "printf ok"]);
    expect(stdout.toString()).toBe("ok");
  });

  it("still blocks the provider CLI through promisify(execFile)", async () => {
    const execFileAsync = promisify(childProcess.execFile);
    await expect(execFileAsync("claude", ["-p", "hi"])).rejects.toThrow(
      /OfflineTestGuard/,
    );
  });

  it("cannot run the Anthropic classifier's real backend", async () => {
    // AnthropicTextClassifierBackend defaults to a query that dynamically
    // imports the Agent SDK and launches the provider CLI. jest.mock() cannot
    // reach that import: it is an eval'd native `import()`, invisible to the
    // module registry. Two barriers stop it, and this asserts the outcome
    // rather than which one fires. Today it is Jest's CJS runtime refusing the
    // dynamic import; if the suite ever gains --experimental-vm-modules that
    // barrier disappears and the spawn guard takes over.
    const backend = new AnthropicTextClassifierBackend();
    await expect(
      backend.classify("classify me", {
        signal: new AbortController().signal,
        tools: [],
        continuation: false,
      }),
    ).rejects.toThrow(/OfflineTestGuard|dynamic import callback/);
  }, 30_000);
});
