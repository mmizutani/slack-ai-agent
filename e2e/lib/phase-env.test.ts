import { phaseEnv } from "./phase-env";

const base = {
  PATH: "/usr/bin",
  ANTHROPIC_API_KEY: "anthropic-key",
  OPENAI_API_KEY: "openai-key",
  AGENT_DEFAULT_PROVIDER: "anthropic",
  AGENT_DEFAULT_MODEL: "anthropic/claude-opus-5",
} as NodeJS.ProcessEnv;

describe("phaseEnv", () => {
  it("pins the provider and its model", () => {
    const env = phaseEnv(base, { provider: "openai" });
    expect(env.AGENT_DEFAULT_PROVIDER).toBe("openai");
    expect(env.AGENT_DEFAULT_MODEL).toBe("openai/gpt-5.6-luna");
  });

  it("blanks the other provider's key so single-provider startup is proven", () => {
    // A phase that still holds both keys enables both runtimes, so an
    // OpenAI-only startup regression would never surface.
    //
    // Blanked rather than deleted: the child calls dotenv.config() from
    // src/config.ts, and dotenv fills in any variable that is *absent* from the
    // environment. Deleting the key therefore hands it straight back from
    // .env. An empty string is present (so dotenv leaves it alone) and falsy
    // (so resolveEnabledProviders does not enable the provider).
    expect(phaseEnv(base, { provider: "openai" }).ANTHROPIC_API_KEY).toBe("");
    expect(phaseEnv(base, { provider: "anthropic" }).OPENAI_API_KEY).toBe("");
  });

  it("blanks rather than deletes, so dotenv cannot refill it in the child", () => {
    const env = phaseEnv(base, { provider: "openai" });
    expect("ANTHROPIC_API_KEY" in env).toBe(true);
  });

  it("keeps the key belonging to the provider under test", () => {
    expect(phaseEnv(base, { provider: "openai" }).OPENAI_API_KEY).toBe(
      "openai-key",
    );
    expect(phaseEnv(base, { provider: "anthropic" }).ANTHROPIC_API_KEY).toBe(
      "anthropic-key",
    );
  });

  it("passes through unrelated variables", () => {
    expect(phaseEnv(base, { provider: "anthropic" }).PATH).toBe("/usr/bin");
  });

  it("does not mutate the base environment", () => {
    phaseEnv(base, { provider: "openai" });
    expect(base.ANTHROPIC_API_KEY).toBe("anthropic-key");
    expect(base.AGENT_DEFAULT_PROVIDER).toBe("anthropic");
  });

  it("wires the fixture MCP config and custom actions directory when given", () => {
    const env = phaseEnv(base, {
      provider: "anthropic",
      mcpConfigPath: "/tmp/mcp.json",
      customActionsDir: "/tmp/actions",
    });
    expect(env.MCP_CONFIG_PATH).toBe("/tmp/mcp.json");
    expect(env.CUSTOM_ACTIONS_DIR).toBe("/tmp/actions");
  });

  it("points only the provider under test at a fake endpoint", () => {
    const anthropic = phaseEnv(base, {
      provider: "anthropic",
      providerBaseUrl: "http://127.0.0.1:9",
    });
    expect(anthropic.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9");
    expect(anthropic.OPENAI_BASE_URL).toBe("");

    const openai = phaseEnv(base, {
      provider: "openai",
      providerBaseUrl: "http://127.0.0.1:9",
    });
    expect(openai.OPENAI_BASE_URL).toBe("http://127.0.0.1:9");
    expect(openai.ANTHROPIC_BASE_URL).toBe("");
  });

  it("blanks base URLs when no fake endpoint is requested", () => {
    // Same dotenv reasoning as the API keys: a deleted base URL would be
    // restored from .env and silently point the phase at a proxy.
    const env = phaseEnv(base, { provider: "anthropic" });
    expect(env.ANTHROPIC_BASE_URL).toBe("");
    expect(env.OPENAI_BASE_URL).toBe("");
  });
});
