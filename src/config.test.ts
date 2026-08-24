import fs from "fs";
import os from "os";
import path from "path";
import {
  buildSandboxFilesystem,
  destroyThreadWorkspace,
  provisionThreadWorkspace,
  resolveEnabledProviders,
  validateEnabledProviders,
} from "./config";

it("enables both configured providers for mixed deployments", () => {
  expect(
    resolveEnabledProviders({
      defaultProvider: "anthropic",
      anthropicApiKey: "anthropic-key",
      openaiApiKey: "openai-key",
    }),
  ).toEqual(["anthropic", "openai"]);
});

it("keeps OpenAI-only deployments free of an Anthropic requirement", () => {
  expect(
    resolveEnabledProviders({
      defaultProvider: "openai",
      openaiApiKey: "openai-key",
    }),
  ).toEqual(["openai"]);
});

it("allows OpenAI-only validation without an Anthropic credential", () => {
  expect(() =>
    validateEnabledProviders({
      defaultProvider: "openai",
      anthropicApiKey: undefined,
      openaiApiKey: "configured",
    }),
  ).not.toThrow();
});

it("accepts an Anthropic auth token without an API key", () => {
  expect(() =>
    validateEnabledProviders({
      defaultProvider: "anthropic",
      anthropicApiKey: undefined,
      anthropicAuthToken: "configured",
      anthropicBaseUrl: "https://anthropic-proxy.example",
    }),
  ).not.toThrow();
});

it("rejects a selected provider with no credential", () => {
  expect(() =>
    validateEnabledProviders({
      defaultProvider: "openai",
      anthropicApiKey: undefined,
      openaiApiKey: undefined,
    }),
  ).toThrow(/OPENAI_API_KEY/i);
});

it("rejects a default model from a different provider", () => {
  expect(() =>
    validateEnabledProviders({
      defaultProvider: "openai",
      defaultModel: { provider: "anthropic", model: "claude-opus-5" },
      openaiApiKey: "configured",
    }),
  ).toThrow(/default model.*provider/i);
});

it.each([
  {
    name: "Anthropic",
    options: {
      defaultProvider: "openai" as const,
      openaiApiKey: "configured",
      anthropicApiKey: undefined,
      smartReplyModel: {
        provider: "anthropic" as const,
        model: "claude-haiku-4-5",
      },
    },
    credential: /ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN/i,
  },
  {
    name: "OpenAI",
    options: {
      defaultProvider: "anthropic" as const,
      anthropicApiKey: "configured",
      openaiApiKey: undefined,
      smartReplyModel: {
        provider: "openai" as const,
        model: "gpt-5.6-luna",
      },
    },
    credential: /OPENAI_API_KEY/i,
  },
])(
  "rejects a $name smart-reply model without its provider credential",
  ({ options, credential }) => {
    expect(() => validateEnabledProviders(options)).toThrow(credential);
  },
);

it("keeps workspace paths short enough for Linux sandbox sockets", () => {
  const sessionKey =
    "synthetic-user-identifier-synthetic-channel-identifier-1234567890.123456";
  const workspace = provisionThreadWorkspace(sessionKey);

  try {
    expect(workspace).toMatch(
      /^\/tmp\/slack-ai-agent\/workspaces\/[a-f0-9]{16}$/,
    );
    expect(path.join(workspace, ".tmp").length).toBeLessThan(60);
  } finally {
    destroyThreadWorkspace(sessionKey);
  }
});

it("allows Bash to access only the cwd and configured auth paths", () => {
  const originalEnv = process.env;
  const home = path.join(os.tmpdir(), "slack-ai-home-test");
  const homedirSpy = jest.spyOn(os, "homedir").mockReturnValue(home);
  process.env = {
    ...process.env,
    CLOUDSDK_CONFIG: os.tmpdir(),
    GOOGLE_APPLICATION_CREDENTIALS: __filename,
  };
  try {
    const rules = buildSandboxFilesystem(__dirname);
    const paths = [__dirname, os.tmpdir(), __filename].map(target =>
      fs.realpathSync(target),
    );
    const mcpJwtHeadersFile = path.join(
      home,
      ".slack-ai-agent",
      "mcp-jwt-headers.json",
    );
    expect(rules.allowRead).toEqual([...paths, mcpJwtHeadersFile]);
    expect(rules.allowWrite).toEqual(rules.allowRead.slice(0, 2));
    expect(rules.denyWrite).toEqual([
      path.join(paths[0], ".claude"),
      path.join(paths[0], ".claude-state"),
    ]);
  } finally {
    homedirSpy.mockRestore();
    process.env = originalEnv;
  }
});

it("allows the default gcloud config when CLOUDSDK_CONFIG is unset", () => {
  const originalEnv = process.env;
  process.env = { ...process.env };
  delete process.env.CLOUDSDK_CONFIG;
  try {
    const rules = buildSandboxFilesystem(__dirname);
    const defaultCloudSdkConfig = path.join(os.homedir(), ".config", "gcloud");
    expect(rules.allowRead).toContain(defaultCloudSdkConfig);
    expect(rules.allowWrite).toContain(defaultCloudSdkConfig);
  } finally {
    process.env = originalEnv;
  }
});
