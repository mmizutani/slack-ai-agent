import {
  computeEffectiveToolPolicy,
  legacyToolIdentities,
} from "./permissions";

describe("tool permissions", () => {
  it("inherits tools and makes global deny win", () => {
    const policy = computeEffectiveToolPolicy(
      "engineer",
      {
        member: ["Read", "mcp__github__get_file_contents"],
        engineer: ["mcp__jenkins__get_build"],
      },
      ["mcp:github/get_file_contents"],
    );

    expect(policy.allowed).toEqual([
      "provider_native:anthropic/Read",
      "mcp:jenkins/get_build",
    ]);
    expect(policy.allowed).not.toContain("mcp:github/get_file_contents");
  });

  it("denies unknown roles and translates legacy workspace names", () => {
    expect(
      computeEffectiveToolPolicy("unknown", { member: ["Read"] }, []),
    ).toEqual(expect.objectContaining({ allowed: [] }));
    expect(legacyToolIdentities("Read")).toEqual([
      "provider_native:anthropic/Read",
      "workspace/read_file",
    ]);
    expect(legacyToolIdentities("Bash(aws:*)")).toEqual([
      "provider_native:anthropic/Bash(aws:*)",
    ]);
  });

  it("parses MCP server names containing underscores", () => {
    expect(legacyToolIdentities("mcp__release_ops__get_status")).toEqual([
      "mcp:release_ops/get_status",
    ]);
    expect(legacyToolIdentities("mcp__release_ops__get__status")).toEqual([
      "mcp:release_ops/get__status",
    ]);
  });

  it("preserves unknown deny entries and lets base Bash deny parameterized Bash tools", () => {
    const policy = computeEffectiveToolPolicy(
      "engineer",
      { engineer: ["Bash(aws:*)", "mcp__github__get_status"] },
      ["Bash", "future_tool"],
    );

    expect(policy.allowed).toEqual(["mcp:github/get_status"]);
    expect(policy.denied).toEqual([
      "provider_native:anthropic/Bash",
      "future_tool",
    ]);
  });
});
