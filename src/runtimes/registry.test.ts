import { AgentRuntimeRegistry } from "./registry";

describe("AgentRuntimeRegistry", () => {
  it("resolves registered runtimes and fails clearly for disabled providers", () => {
    const registry = new AgentRuntimeRegistry();
    const runtime = {
      provider: "anthropic" as const,
      stream: async function* () {},
    };

    registry.register(runtime);

    expect(registry.get("anthropic")).toBe(runtime);
    expect(() => registry.get("openai")).toThrow(/not enabled.*openai/i);
  });
});
