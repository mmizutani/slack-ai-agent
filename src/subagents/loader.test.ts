import fs from "fs";
import os from "os";
import path from "path";
import { loadSubagentDefinitions } from "./loader";

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
    fs.writeFileSync(path.join(directory, "example-ignore.yaml"), "name: ignored\n");
    fs.writeFileSync(path.join(directory, "invalid.yaml"), "name: missing-fields\n");

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
