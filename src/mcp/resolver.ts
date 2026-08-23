import type { McpServerConfig } from "../mcp-manager";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  McpServerDefinition,
  RequesterIdentity,
  ResolvedMcpServerDefinition,
} from "./types";

const execFileAsync = promisify(execFile);
const HEADERS_HELPER_TIMEOUT_MS = 10_000;
const HEADERS_HELPER_MAX_BUFFER = 64 * 1024;
const HEADERS_HELPER_ENV_KEYS = [
  "PATH",
  "HOME",
  "CLOUDSDK_CONFIG",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AWS_PROFILE",
  "AWS_REGION",
] as const;

function headersHelperEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    HEADERS_HELPER_ENV_KEYS.flatMap(key =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );
}

async function resolveHeadersHelper(
  helper: string,
): Promise<Record<string, string>> {
  if (!helper.trim()) throw new Error("MCP headers helper is empty");
  const { stdout } = await execFileAsync(
    "/bin/sh",
    ["-c", helper],
    {
      timeout: HEADERS_HELPER_TIMEOUT_MS,
      maxBuffer: HEADERS_HELPER_MAX_BUFFER,
      windowsHide: true,
      env: headersHelperEnv(),
    },
  );
  const parsed: unknown = JSON.parse(stdout.toString());
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MCP headers helper must return a JSON object");
  }
  const entries = Object.entries(parsed);
  if (entries.some(([name, value]) => !name || typeof value !== "string")) {
    throw new Error("MCP headers helper returned invalid headers");
  }
  return parsed as Record<string, string>;
}

function emailFromIdentity(
  requester: RequesterIdentity | string | undefined,
): string | undefined {
  const email = typeof requester === "string" ? requester : requester?.email;
  const normalized = email?.trim();
  return normalized || undefined;
}

function normalize(
  name: string,
  value: McpServerConfig | McpServerDefinition,
): McpServerDefinition | undefined {
  if (!value || typeof value !== "object") return undefined;
  const config = value as any;
  if ((!config.type || config.type === "stdio") && config.command) {
    return {
      name,
      transport: "stdio",
      command: config.command,
      ...(config.args ? { args: [...config.args] } : {}),
      ...(config.env ? { env: { ...config.env } } : {}),
    };
  }
  if (config.type === "http" || config.transport === "streamable_http") {
    return {
      name,
      transport: "streamable_http",
      url: config.url,
      ...(config.headers ? { headers: { ...config.headers } } : {}),
      ...(config.headersHelper ? { headersHelper: config.headersHelper } : {}),
      ...(config.userEmailHeader
        ? { userEmailHeader: config.userEmailHeader }
        : {}),
    };
  }
  if (config.type === "sse" || config.transport === "sse") {
    return {
      name,
      transport: "sse",
      url: config.url,
      ...(config.headers ? { headers: { ...config.headers } } : {}),
      ...(config.headersHelper ? { headersHelper: config.headersHelper } : {}),
      ...(config.userEmailHeader
        ? { userEmailHeader: config.userEmailHeader }
        : {}),
      legacy: true,
    };
  }
  return undefined;
}

export async function resolveMcpServers(
  definitions:
    | Record<string, McpServerConfig | McpServerDefinition>
    | McpServerDefinition[],
  requester: RequesterIdentity | string | undefined,
): Promise<ResolvedMcpServerDefinition[]> {
  const entries = Array.isArray(definitions)
    ? definitions.map(definition => [definition.name, definition] as const)
    : Object.entries(definitions);
  const email = emailFromIdentity(requester);
  const resolved: ResolvedMcpServerDefinition[] = [];

  for (const [name, value] of entries) {
    const definition = normalize(name, value);
    if (!definition) continue;
    if (definition.transport === "stdio") {
      resolved.push(definition);
      continue;
    }

    const headerName = definition.userEmailHeader?.trim();
    if (headerName && !email) continue;
    const { userEmailHeader: _marker, headersHelper: _helper, ...sdk } =
      definition as Extract<McpServerDefinition, { transport: "sse" | "streamable_http" }>;
    let dynamicHeaders: Record<string, string> = {};
    if (definition.headersHelper) {
      try {
        dynamicHeaders = await resolveHeadersHelper(definition.headersHelper);
      } catch {
        // A dynamic credential failure must not expose a partially-authenticated
        // server to the model. Omit the server without logging header values.
        continue;
      }
    }
    const headers = {
      ...(sdk.headers ?? {}),
      ...dynamicHeaders,
      ...(headerName && email ? { [headerName]: email } : {}),
    };
    resolved.push({
      ...sdk,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    } as ResolvedMcpServerDefinition);
  }

  return resolved;
}
