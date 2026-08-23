import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { OPUS_MODEL } from "./request-mode";
import { AgentProviderId, ModelRef, parseModelRef } from "./agent/model";
import { resolveOpenAIModel } from "./runtimes/openai/model-config";

dotenv.config();

function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

// The Claude Agent SDK's working directory lives under /tmp so the agent
// never reads from or writes to the application directory.  Each Slack
// thread gets its own subdirectory under workspaces/ with curated skills and
// data physically inside the sandbox.
export const SANDBOX_ROOT = "/tmp/slack-ai-agent";
const WORKSPACES_DIR = path.join(SANDBOX_ROOT, "workspaces");

// Linux sandbox bridge sockets have a short path limit, so workspace names
// must leave enough room for socket filenames under the workspace temp dir.
const threadWorkspace = (sessionKey: string): string =>
  path.join(
    WORKSPACES_DIR,
    crypto.createHash("sha256").update(sessionKey).digest("hex").slice(0, 16),
  );

/** Replace dest with a fresh copy of source. Copies to a temp dir first
 *  so the sandbox keeps its old copy if the source read fails. */
function copyDirIntoSandbox(source: string, dest: string): void {
  if (!fs.existsSync(source)) return;
  const tmp = `${dest}.tmp`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.cpSync(source, tmp, { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
}

// How often to re-sync data/ from source so thread workspaces stay current.
const DATA_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

function refreshAllWorkspaceData(): void {
  if (!fs.existsSync(WORKSPACES_DIR)) return;
  for (const name of fs.readdirSync(WORKSPACES_DIR)) {
    const workspace = path.join(WORKSPACES_DIR, name);
    try {
      if (!fs.statSync(workspace).isDirectory()) continue;
      copyDirIntoSandbox(path.resolve("data"), path.join(workspace, "data"));
    } catch {
      // Non-fatal — workspace keeps its previous copy until the next sync.
    }
  }
}

function ensureSandboxRoot(): string {
  fs.mkdirSync(WORKSPACES_DIR, { recursive: true });

  // Re-sync data/ in every active thread workspace periodically so
  // employees.yaml stays current as external sync jobs update the source.
  // .unref() prevents the interval from blocking process exit.
  setInterval(refreshAllWorkspaceData, DATA_REFRESH_INTERVAL_MS).unref();

  return SANDBOX_ROOT;
}

/** Create or refresh the per-thread agent workspace for a Slack session. */
export function provisionThreadWorkspace(sessionKey: string): string {
  const workspace = threadWorkspace(sessionKey);
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(workspace, ".tmp"), { recursive: true });
  fs.mkdirSync(path.join(workspace, ".claude-state"), { recursive: true });
  const claudeDir = path.join(workspace, ".claude");
  fs.rmSync(claudeDir, { recursive: true, force: true });
  copyDirIntoSandbox(
    path.resolve(".claude/skills"),
    path.join(claudeDir, "skills"),
  );
  try {
    copyDirIntoSandbox(path.resolve("data"), path.join(workspace, "data"));
  } catch {
    // Bot can serve the thread without employee data — users are non-employee.
  }
  return workspace;
}

/** Remove a thread workspace when its session is evicted. */
export function destroyThreadWorkspace(sessionKey: string): void {
  fs.rmSync(threadWorkspace(sessionKey), {
    recursive: true,
    force: true,
  });
}

const resolvedPaths = (...paths: Array<string | undefined>): string[] =>
  paths.flatMap(value =>
    value
      ? [fs.existsSync(value) ? fs.realpathSync(value) : path.resolve(value)]
      : [],
  );

export const getCloudSdkConfig = (): string =>
  process.env.CLOUDSDK_CONFIG || path.join(os.homedir(), ".config", "gcloud");

const getMcpJwtHeadersFile = (): string =>
  path.join(os.homedir(), ".slack-ai-agent", "mcp-jwt-headers.json");

/** Bash can access the cwd and the explicitly configured auth paths. */
export const buildSandboxFilesystem = (workingDirectory: string) => {
  return {
    denyRead: resolvedPaths(
      os.homedir(),
      path.resolve("."),
      path.dirname(SANDBOX_ROOT),
      os.tmpdir(),
    ),
    allowRead: resolvedPaths(
      workingDirectory,
      getCloudSdkConfig(),
      process.env.GOOGLE_APPLICATION_CREDENTIALS,
      getMcpJwtHeadersFile(),
    ),
    allowWrite: resolvedPaths(workingDirectory, getCloudSdkConfig()),
    denyWrite: resolvedPaths(
      path.join(workingDirectory, ".claude"),
      path.join(workingDirectory, ".claude-state"),
    ),
  };
};

/**
 * Network rules for the Bash sandbox. Adds the Google Cloud and AWS endpoints
 * the data-skill CLIs need on top of the SDK's managed domains.
 */
export const SANDBOX_NETWORK = {
  allowedDomains: ["*.googleapis.com", "*.amazonaws.com", "169.254.169.254"],
};

function parseProvider(value: string | undefined): AgentProviderId {
  if (!value || value === "anthropic") return "anthropic";
  if (value === "openai") return "openai";
  throw new Error(`Invalid AGENT_DEFAULT_PROVIDER: ${value}`);
}

const defaultProvider = parseProvider(process.env.AGENT_DEFAULT_PROVIDER);
const defaultModel: ModelRef = parseModelRef(
  process.env.AGENT_DEFAULT_MODEL ||
    (defaultProvider === "openai"
      ? `openai/${resolveOpenAIModel()}`
      : OPUS_MODEL),
);

export interface ProviderValidationOptions {
  defaultProvider?: AgentProviderId;
  defaultModel?: ModelRef;
  enabledProviders?: AgentProviderId[];
  anthropicApiKey?: string;
  openaiApiKey?: string;
  openaiStoreResponses?: boolean;
  openaiSessionMode?: "previous_response_id" | "sdk_session";
  anthropicBaseUrl?: string;
  anthropicAuthToken?: string;
  smartReplyModel?: ModelRef;
}

export function resolveEnabledProviders(
  options: Pick<
    ProviderValidationOptions,
    | "defaultProvider"
    | "anthropicApiKey"
    | "anthropicAuthToken"
    | "openaiApiKey"
  >,
): AgentProviderId[] {
  const enabled = new Set<AgentProviderId>([
    options.defaultProvider ?? "anthropic",
  ]);
  if (options.anthropicApiKey || options.anthropicAuthToken) {
    enabled.add("anthropic");
  }
  if (options.openaiApiKey) enabled.add("openai");
  return (["anthropic", "openai"] as const).filter(provider =>
    enabled.has(provider),
  );
}

/** Validate only providers selected by deployment configuration. */
export function validateEnabledProviders(
  options: ProviderValidationOptions = {},
): void {
  const configuredProviders =
    options.enabledProviders ??
    (options.defaultProvider
      ? resolveEnabledProviders({
          defaultProvider: options.defaultProvider,
          anthropicApiKey: options.anthropicApiKey,
          anthropicAuthToken: options.anthropicAuthToken,
          openaiApiKey: options.openaiApiKey,
        })
      : config.agent.enabledProviders);
  const smartReplyModel =
    "smartReplyModel" in options
      ? options.smartReplyModel
      : config.smartReplyModel;
  const selected = new Set(configuredProviders);
  if (smartReplyModel) selected.add(smartReplyModel.provider);
  const anthropicApiKey =
    "anthropicApiKey" in options
      ? options.anthropicApiKey
      : config.anthropic.apiKey;
  const anthropicAuthToken =
    "anthropicAuthToken" in options
      ? options.anthropicAuthToken
      : config.anthropic.authToken;
  const anthropicBaseUrl =
    "anthropicBaseUrl" in options
      ? options.anthropicBaseUrl
      : config.anthropic.baseUrl;
  const openaiApiKey =
    "openaiApiKey" in options ? options.openaiApiKey : config.openai.apiKey;
  const configuredDefaultProvider =
    options.defaultProvider ?? config.agent.defaultProvider;
  const configuredDefaultModel =
    options.defaultModel ??
    (options.defaultProvider ? undefined : config.agent.defaultModel);

  if (
    configuredDefaultModel &&
    configuredDefaultModel.provider !== configuredDefaultProvider
  ) {
    throw new Error(
      `Default model provider ${configuredDefaultModel.provider} does not match default provider ${configuredDefaultProvider}`,
    );
  }

  if (selected.has("anthropic")) {
    if (!anthropicApiKey && !anthropicAuthToken) {
      throw new Error(
        "Anthropic runtime is enabled but ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is missing",
      );
    }
    if (anthropicAuthToken && !anthropicBaseUrl) {
      throw new Error(
        "ANTHROPIC_BASE_URL is required when using ANTHROPIC_AUTH_TOKEN",
      );
    }
  }
  if (selected.has("openai") && !openaiApiKey) {
    throw new Error("OpenAI runtime is enabled but OPENAI_API_KEY is missing");
  }

  const storeResponses =
    options.openaiStoreResponses ?? config.openai.storeResponses;
  const sessionMode = options.openaiSessionMode ?? config.openai.sessionMode;
  if (!storeResponses && sessionMode === "previous_response_id") {
    throw new Error(
      "OPENAI_STORE_RESPONSES=false requires OPENAI_SESSION_MODE=sdk_session",
    );
  }
}

export const config = {
  slack: {
    botToken: getRequiredEnv("CC_SLACK_BOT_TOKEN"),
    appToken: getRequiredEnv("CC_SLACK_APP_TOKEN"),
    signingSecret: getRequiredEnv("CC_SLACK_SIGNING_SECRET"),
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
    authToken: process.env.ANTHROPIC_AUTH_TOKEN,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    model: OPUS_MODEL, // Claude Opus 5 - most capable model
  },
  agent: {
    defaultProvider,
    defaultModel,
    enabledProviders: resolveEnabledProviders({
      defaultProvider,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN,
      openaiApiKey: process.env.OPENAI_API_KEY,
    }),
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL,
    organization: process.env.OPENAI_ORGANIZATION,
    project: process.env.OPENAI_PROJECT,
    model: resolveOpenAIModel(),
    sessionMode:
      process.env.OPENAI_SESSION_MODE === "sdk_session"
        ? ("sdk_session" as const)
        : ("previous_response_id" as const),
    tracingEnabled: process.env.OPENAI_TRACING_ENABLED === "true",
    storeResponses: process.env.OPENAI_STORE_RESPONSES !== "false",
  },
  smartReplyModel: process.env.SMART_REPLY_MODEL
    ? parseModelRef(process.env.SMART_REPLY_MODEL)
    : undefined,
  slackWorkspaceUrl: getRequiredEnv("SLACK_WORKSPACE_URL"),
  // Optional Slack channel for operational alerts (e.g. model fallback). When
  // unset, no ops notifications are sent. Set OPS_ALERT_CHANNEL_ID in the
  // deployment environment to enable them.
  opsAlertChannelId: process.env.OPS_ALERT_CHANNEL_ID || undefined,
  trackingClientId: process.env.TRACKING_CLIENT_ID || "slack-ai-agent",
  baseDirectory: ensureSandboxRoot(),
  // Persistent state that must survive process restarts (deploys).
  // Defaults to a .persist/ directory in the app root — NOT under /tmp.
  persistDir: process.env.PERSIST_DIR || path.resolve(".persist"),
  debug: process.env.DEBUG === "true" || process.env.NODE_ENV === "development",
};
