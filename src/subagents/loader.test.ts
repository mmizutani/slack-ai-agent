import fs from "fs";
import os from "os";
import path from "path";
import { intersectSubagentTools, loadSubagentDefinitions } from "./loader";

describe("provider-neutral subagent loader", () => {
  it("maps legacy prompt and model aliases into a provider-neutral definition", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-"));
    fs.writeFileSync(
      path.join(directory, "validator.yaml"),
      [
        "name: validator",
        "description: Validate a response",
        "model: haiku",
        "prompt: Check the response",
        "tools:",
        "  - Read",
        "maxTurns: 4",
        "",
      ].join("\n"),
    );

    expect(loadSubagentDefinitions(directory)).toEqual([
      {
        name: "validator",
        description: "Validate a response",
        model: { provider: "anthropic", model: "claude-haiku-4-5" },
        instructions: "Check the response",
        tools: ["Read"],
        maxTurns: 4,
      },
    ]);
  });

  it("omits example files and malformed definitions", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-"));
    fs.writeFileSync(
      path.join(directory, "example-ignore.yaml"),
      "name: ignored\n",
    );
    fs.writeFileSync(
      path.join(directory, "invalid.yaml"),
      "name: missing-fields\n",
    );

    expect(loadSubagentDefinitions(directory)).toEqual([]);
  });

  it("treats a present malformed tools field as an empty restriction", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-"));
    fs.writeFileSync(
      path.join(directory, "restricted.yaml"),
      [
        "name: restricted",
        "description: Must not inherit tools",
        "instructions: Check the response",
        "tools: Read",
        "",
      ].join("\n"),
    );

    expect(loadSubagentDefinitions(directory)[0].tools).toEqual([]);
  });
});

describe("intersectSubagentTools", () => {
  // "Read", "Grep" and "Glob" each map to two identities: the Claude native
  // tool and the OpenAI workspace alias. computeEffectiveToolPolicy grants only
  // the native one unless the workspace alias is configured explicitly, so
  // matching on either identity would let a legacy name hand the OpenAI runtime
  // a workspace tool the parent never allowed.
  it("does not let a legacy alias claim the OpenAI workspace tool", () => {
    expect(
      intersectSubagentTools(
        ["provider_native:anthropic/Read"],
        ["Read"],
        [],
        "openai",
      ),
    ).toEqual([]);
  });

  it("keeps a legacy alias for the provider that actually allows it", () => {
    expect(
      intersectSubagentTools(
        ["provider_native:anthropic/Read"],
        ["Read"],
        [],
        "anthropic",
      ),
    ).toEqual(["Read"]);
    expect(
      intersectSubagentTools(["workspace/read_file"], ["Read"], [], "openai"),
    ).toEqual(["Read"]);
  });

  it("does not let a legacy alias claim the Claude native tool either", () => {
    expect(
      intersectSubagentTools(
        ["workspace/read_file"],
        ["Read"],
        [],
        "anthropic",
      ),
    ).toEqual([]);
  });

  it("still matches on either identity when no provider is given", () => {
    expect(
      intersectSubagentTools(["provider_native:anthropic/Read"], ["Read"]),
    ).toEqual(["Read"]);
  });

  it("rejects a name when any of its identities is denied", () => {
    expect(
      intersectSubagentTools(
        ["provider_native:anthropic/Read"],
        ["Read"],
        ["workspace/read_file"],
        "anthropic",
      ),
    ).toEqual([]);
  });

  it("drops a name that maps to no identity", () => {
    // A bare server name is not a tool: only mcp__<server>__<tool> resolves.
    expect(
      intersectSubagentTools(
        ["mcp:github/create_issue"],
        ["mcp__github"],
        [],
        "openai",
      ),
    ).toEqual([]);
    expect(
      intersectSubagentTools(
        ["mcp:github/create_issue"],
        ["mcp__github__create_issue"],
        [],
        "openai",
      ),
    ).toEqual(["mcp__github__create_issue"]);
  });
});
