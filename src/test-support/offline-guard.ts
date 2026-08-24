/**
 * Keeps the unit-test suite offline.
 *
 * Installed from `src/test-setup.ts`, which Jest loads as a `setupFiles` entry
 * — before the test framework and before any application module, including
 * `config.ts` and its `dotenv.config()` call.
 *
 * Two independent measures, because neither is sufficient alone:
 *
 *   1. `scrubProviderCredentials` replaces every provider credential with a
 *      placeholder, so a request that escapes anyway is unauthenticated and
 *      therefore free.
 *   2. `installOfflineGuard` refuses outbound sockets and provider-CLI spawns,
 *      so no request escapes in the first place.
 *
 * Scrubbing alone still lets a runaway test hammer a live endpoint. Blocking
 * alone still leaves a real key in memory for any path that shells out to a
 * provider CLI, which does its own I/O in a process this one cannot patch.
 */

import net from "net";
import childProcess from "child_process";
import util from "util";

export const GUARD_NAME = "OfflineTestGuard";

/**
 * Credentials the suite needs to be present but must never be real.
 *
 * `config.ts` calls `dotenv.config()` at import time, so the developer's real
 * `.env` is read into `process.env` on every test run. dotenv never overwrites
 * a variable that is already set, which is what makes seeding these effective.
 */
export const PLACEHOLDER_CREDENTIALS: Readonly<Record<string, string>> = {
  CC_SLACK_BOT_TOKEN: "xoxb-test",
  CC_SLACK_APP_TOKEN: "xapp-test",
  CC_SLACK_SIGNING_SECRET: "test-signing-secret",
  SLACK_WORKSPACE_URL: "https://test.slack.com",
  SLACK_MCP_XOXP_TOKEN: "xoxp-test",
  ANTHROPIC_API_KEY: "sk-ant-test",
  OPENAI_API_KEY: "sk-openai-test",
};

/**
 * Credentials and endpoint overrides with no meaningful placeholder. A
 * leftover OAuth token authenticates just as well as an API key, and a
 * leftover base URL points the SDK at a gateway the placeholder key above was
 * never checked against.
 */
export const CLEARED_CREDENTIAL_KEYS: readonly string[] = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
];

/**
 * Overwrite provider credentials in `env`.
 *
 * Assignment is unconditional, not `??=`: on a machine that also runs the
 * agent — and in CI that exports a key for other jobs — the real value is
 * already in the environment, and `??=` would preserve exactly the value this
 * is meant to remove.
 */
export function scrubProviderCredentials(env: NodeJS.ProcessEnv): void {
  for (const [key, placeholder] of Object.entries(PLACEHOLDER_CREDENTIALS)) {
    env[key] = placeholder;
  }
  for (const key of CLEARED_CREDENTIAL_KEYS) {
    delete env[key];
  }
  // The Agents SDK ships traces to OpenAI on a background exporter unless
  // tracing is disabled. `createOpenAIRunner` disables it per-runner, but a
  // test that builds an `Agent` or `Runner` by hand would not.
  env.OPENAI_AGENTS_DISABLE_TRACING = "1";
}

export function guardError(what: string): Error {
  const error = new Error(
    `${GUARD_NAME}: blocked ${what}. Unit tests must not reach the network — ` +
      `inject a fake or use jest.mock() for this dependency.`,
  );
  error.name = GUARD_NAME;
  return error;
}

const LOOPBACK_IPV4 = /^(::ffff:)?127(\.\d{1,3}){3}$/;

/** Loopback and IPC targets stay reachable so a test may stand up a local server. */
export function isLoopbackHost(host: unknown): boolean {
  if (host === undefined || host === null || host === "") return true;
  if (typeof host !== "string") return false;
  const bare = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  // Anchor the IPv4 form. A `startsWith("127.")` test would also accept
  // `127.0.0.1.evil.example`, a hostname anyone can point at a real endpoint.
  return (
    bare === "localhost" ||
    bare === "::1" ||
    bare === "0.0.0.0" ||
    bare === "::" ||
    LOOPBACK_IPV4.test(bare)
  );
}

/** Describe a `Socket.prototype.connect` target, or `undefined` when allowed. */
export function connectTarget(args: readonly unknown[]): string | undefined {
  // `net.connect()`/`net.createConnection()` do not forward their own
  // arguments: they hand `Socket.prototype.connect` Node's normalized
  // `[options, callback]` array. Reading `.host` off that array yields
  // `undefined`, which reads as loopback and would let the connection through.
  const normalized = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
  const [first, second] = normalized as [unknown, unknown];
  // connect(path[, listener]) — IPC/unix socket, never remote.
  if (typeof first === "string") return undefined;
  // connect(port[, host][, listener])
  if (typeof first === "number") {
    const host = typeof second === "string" ? second : undefined;
    return isLoopbackHost(host) ? undefined : `${host}:${first}`;
  }
  // connect(options[, listener])
  if (first && typeof first === "object") {
    const options = first as { host?: string; port?: number; path?: string };
    if (typeof options.path === "string") return undefined;
    return isLoopbackHost(options.host)
      ? undefined
      : `${options.host}:${options.port}`;
  }
  return undefined;
}

// The Anthropic and OpenAI agent runtimes reach their APIs by spawning a
// provider CLI, which does its own I/O in a child process where the socket
// patch has no effect. `src/mcp/resolver.ts` legitimately spawns `/bin/sh`, so
// this is a denylist of agent binaries rather than an allowlist.
const AGENT_CLI =
  /(^|[/\\])(claude|claude-code|codex)(\.(js|cjs|mjs|exe|cmd))?$/i;
const AGENT_MODULE =
  /@anthropic-ai\/(claude-agent-sdk|claude-code)|@openai\/codex/i;

/** Return the offending command line when a spawn would launch a provider CLI. */
export function agentCliCommandLine(
  command: unknown,
  args: unknown,
): string | undefined {
  if (typeof command !== "string") return undefined;
  const argv = Array.isArray(args)
    ? args.filter((arg): arg is string => typeof arg === "string")
    : [];
  const line = [command, ...argv].join(" ");
  const offends =
    AGENT_CLI.test(command) ||
    argv.some(arg => AGENT_CLI.test(arg)) ||
    AGENT_MODULE.test(line);
  return offends ? line : undefined;
}

let installed = false;

/** Patch the process so no outbound request or provider CLI can start. */
export function installOfflineGuard(): void {
  if (installed) return;
  installed = true;

  // Every Node HTTP client — http/https, axios, undici's `fetch`, node-fetch,
  // the provider SDKs — ends up here, so this one patch closes all of them.
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(
    this: net.Socket,
    ...args: unknown[]
  ) {
    const target = connectTarget(args);
    if (target !== undefined) throw guardError(`TCP connect to ${target}`);
    return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;

  // `fetch` is patched too, one layer above the socket, so the failure names
  // the URL instead of surfacing as an opaque connection error.
  const realFetch = globalThis.fetch;
  if (typeof realFetch === "function") {
    globalThis.fetch = ((input: unknown, init?: unknown) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as { url?: string } | null)?.url;
      let host: string | undefined;
      try {
        host = new URL(String(raw)).hostname;
      } catch {
        host = undefined;
      }
      if (!isLoopbackHost(host)) {
        return Promise.reject(guardError(`fetch ${raw}`));
      }
      return (realFetch as (a: unknown, b?: unknown) => Promise<Response>)(
        input,
        init,
      );
    }) as typeof globalThis.fetch;
  }

  for (const name of [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ] as const) {
    const real = childProcess[name] as (...a: unknown[]) => unknown;
    const guarded = function guardedSpawn(this: unknown, ...args: unknown[]) {
      const line = agentCliCommandLine(args[0], args[1]);
      if (line !== undefined) {
        throw guardError(`spawn of provider CLI \`${line}\``);
      }
      return real.apply(this, args);
    };

    // `exec`/`execFile` carry a `util.promisify.custom` implementation that
    // resolves to `{ stdout, stderr }`. A plain wrapper does not, so
    // `promisify()` would fall back to generic callback promisification and
    // resolve to `stdout` alone — silently breaking every caller that
    // destructures the result (`src/mcp/resolver.ts` does). Re-attach a
    // guarded version rather than the original, so promisified callers are
    // covered too.
    const realCustom = (real as unknown as Record<symbol, unknown>)[
      util.promisify.custom
    ];
    if (typeof realCustom === "function") {
      (guarded as unknown as Record<symbol, unknown>)[util.promisify.custom] =
        function guardedSpawnAsync(this: unknown, ...args: unknown[]) {
          const line = agentCliCommandLine(args[0], args[1]);
          if (line !== undefined) {
            return Promise.reject(
              guardError(`spawn of provider CLI \`${line}\``),
            );
          }
          return (realCustom as (...a: unknown[]) => unknown).apply(this, args);
        };
    }

    (childProcess as unknown as Record<string, unknown>)[name] = guarded;
  }
}
