import fs from "fs";
import os from "os";
import path from "path";
import { readWorkspaceFile, searchWorkspaceText, listWorkspaceFiles } from "./tools";

describe("bounded workspace tools", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-tools-"));
    fs.mkdirSync(path.join(root, "docs"));
    fs.writeFileSync(path.join(root, "docs", "readme.txt"), "alpha\nbeta\n");
    fs.writeFileSync(path.join(root, "docs", "image.bin"), Buffer.from([0, 1, 2]));
  });

  it("reads text with a bounded output", async () => {
    await expect(readWorkspaceFile(root, "docs/readme.txt", { maxOutputChars: 5 })).resolves.toEqual({
      kind: "text",
      path: "docs/readme.txt",
      content: "alpha",
      truncated: true,
    });
  });

  it("returns a capability message for binary files", async () => {
    await expect(readWorkspaceFile(root, "docs/image.bin")).resolves.toMatchObject({
      kind: "binary",
      path: "docs/image.bin",
    });
  });

  it("bounds list and search results", async () => {
    await expect(listWorkspaceFiles(root, ".", { maxEntries: 1 })).resolves.toMatchObject({
      entries: expect.any(Array),
      truncated: true,
    });
    await expect(searchWorkspaceText(root, "a", { maxMatches: 1 })).resolves.toMatchObject({
      matches: expect.any(Array),
      truncated: true,
    });
  });

  it("bounds aggregate list and search output, not only item counts", async () => {
    const listed = await listWorkspaceFiles(root, ".", { maxOutputChars: 10 });
    expect(listed.entries.join("\n").length).toBeLessThanOrEqual(10);
    expect(listed.truncated).toBe(true);

    const searched = await searchWorkspaceText(root, "a", { maxOutputChars: 60 });
    expect(JSON.stringify(searched.matches).length).toBeLessThanOrEqual(60);
    expect(searched.truncated).toBe(true);
  });

  it("uses the output budget only for returned search matches", async () => {
    const nested = path.join(root, "docs", "a-very-long-directory-name");
    fs.mkdirSync(nested);
    fs.writeFileSync(
      path.join(nested, "late-match.txt"),
      `${"prefix\n".repeat(20)}needle\n`,
    );

    const searched = await searchWorkspaceText(root, "needle", {
      maxOutputChars: 120,
    });

    expect(searched.matches).toEqual([
      expect.objectContaining({
        path: "docs/a-very-long-directory-name/late-match.txt",
      }),
    ]);
  });

  it("skips cyclic, broken, and escaping symlinks while listing", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync("..", path.join(root, "docs", "cycle"));
    fs.symlinkSync(
      path.join(outside, "secret.txt"),
      path.join(root, "docs", "outside"),
    );
    fs.symlinkSync("missing.txt", path.join(root, "docs", "broken"));

    const listed = await listWorkspaceFiles(root);

    expect(listed.entries).toEqual([
      "docs/image.bin",
      "docs/readme.txt",
    ]);
    expect(listed.truncated).toBe(false);
  });

  it("bounds traversal even when a tree contains only directories", async () => {
    let current = path.join(root, "directory-only");
    fs.mkdirSync(current);
    for (let index = 0; index < 10; index += 1) {
      current = path.join(current, `level-${index}`);
      fs.mkdirSync(current);
    }

    const listed = await listWorkspaceFiles(root, "directory-only", {
      maxTraversalEntries: 3,
    });

    expect(listed.entries).toEqual([]);
    expect(listed.truncated).toBe(true);
  });
});
