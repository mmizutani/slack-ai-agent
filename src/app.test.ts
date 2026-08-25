import { createApp } from "./app";

describe("createApp", () => {
  beforeEach(() => {
    // startSessionCleanup and friends register intervals; fake timers keep the
    // suite from holding real handles open.
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("wires the app without performing any network I/O", async () => {
    // The offline guard refuses outbound sockets, so reaching Slack here would
    // throw rather than pass. Bolt only calls auth.test from the deferred
    // App#init path, which createApp does not use.
    const wired = await createApp();

    expect(wired.app).toBeDefined();
    expect(wired.slackHandler).toBeDefined();
  });

  it("exposes Bolt's processEvent, the only way to drive a button click", async () => {
    // Slack has no Web API that originates a block_actions payload. The live
    // verification harness depends on this staying public across Bolt upgrades.
    const wired = await createApp();

    expect(typeof wired.app.processEvent).toBe("function");
  });

  it("reports the providers it enabled", async () => {
    // The verification harness asserts on this to prove a single-provider
    // phase was not silently re-broadened by dotenv refilling a blanked key.
    const wired = await createApp();

    expect(wired.enabledProviders).toEqual(["anthropic", "openai"]);
  });

  it("registers a runtime for every enabled provider", async () => {
    const wired = await createApp();

    expect(wired.runtimeRegistry.get("anthropic").provider).toBe("anthropic");
    expect(wired.runtimeRegistry.get("openai").provider).toBe("openai");
  });
});
