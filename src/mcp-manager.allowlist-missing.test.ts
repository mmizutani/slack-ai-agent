import fs from "fs";
import { McpManager } from "./mcp-manager";

/**
 * A fresh checkout has config/example-tool-allowlist.yaml but no
 * config/tool-allowlist.yaml. Reading the missing file threw ENOENT from inside
 * the Claude streaming path, which retried three times and then replied
 * "Something went wrong" — so the bot could not answer at all.
 *
 * Unlike channels.yaml and emojis.yaml, this file must NOT fall back to its
 * example: an allowlist grants permissions, and adopting the example's grants
 * because the operator forgot to write one would be worse than granting none.
 */
describe("tool allowlist when config/tool-allowlist.yaml is absent", () => {
  let existsSync: jest.SpyInstance;

  beforeEach(() => {
    existsSync = jest.spyOn(fs, "existsSync").mockReturnValue(false);
  });

  afterEach(() => {
    existsSync.mockRestore();
  });

  it("grants no tools instead of throwing", async () => {
    await expect(new McpManager().getAllowedTools("member")).resolves.toEqual(
      [],
    );
  });

  it("reports no role hierarchy instead of throwing", async () => {
    await expect(new McpManager().getHighestRole()).resolves.toBeUndefined();
  });

  it("returns an empty effective policy instead of throwing", async () => {
    const policy = await new McpManager().getEffectiveToolPolicy("member");

    expect(policy.allowed).toEqual([]);
    expect(policy.allowedTools).toEqual([]);
  });
});
