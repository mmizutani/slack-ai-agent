import fs from "fs";
import os from "os";
import path from "path";
import {
  readWorkspaceFile,
  searchWorkspaceText,
  listWorkspaceFiles,
} from "./tools";

describe("bounded workspace tools", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-tools-"));
    fs.mkdirSync(path.join(root, "docs"));
    fs.writeFileSync(path.join(root, "docs", "readme.txt"), "alpha\nbeta\n");
    fs.writeFileSync(
      path.join(root, "docs", "image.bin"),
      Buffer.from([0, 1, 2]),
    );
  });

  it("reads text with a bounded output", async () => {
    await expect(
      readWorkspaceFile(root, "docs/readme.txt", { maxOutputChars: 5 }),
    ).resolves.toEqual({
      kind: "text",
      path: "docs/readme.txt",
      content: "alpha",
      truncated: true,
    });
  });

  // buildWorkspaceTools serializes these results with JSON.stringify. Escaping
  // expands control characters sixfold and doubles quotes and backslashes, so a
  // limit applied to the decoded text does not bound the payload the model
  // actually receives.
  it("bounds read output by its serialized length", async () => {
    fs.writeFileSync(
      path.join(root, "docs", "control.txt"),
      "\u0001".repeat(200),
    );

    const result = await readWorkspaceFile(root, "docs/control.txt", {
      maxOutputChars: 40,
    });

    expect(result.kind).toBe("text");
    if (result.kind !== "text") throw new Error("expected text");
    expect(JSON.stringify(result.content).length).toBeLessThanOrEqual(40);
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.truncated).toBe(true);
  });

  it("bounds list output by the serialized entry length", async () => {
    fs.mkdirSync(path.join(root, "esc"));
    // 24 characters decoded, 29 serialized: a budget between the two accepts
    // the entry on decoded length and then overruns.
    fs.writeFileSync(path.join(root, "esc", 'say "hi" \\ again.txt'), "x");

    const listed = await listWorkspaceFiles(root, "esc", {
      maxOutputChars: 28,
    });

    expect(JSON.stringify(listed.entries).length).toBeLessThanOrEqual(28);
    expect(listed.truncated).toBe(true);
  });

  it("returns a capability message for binary files", async () => {
    await expect(
      readWorkspaceFile(root, "docs/image.bin"),
    ).resolves.toMatchObject({
      kind: "binary",
      path: "docs/image.bin",
    });
  });

  it("bounds list and search results", async () => {
    await expect(
      listWorkspaceFiles(root, ".", { maxEntries: 1 }),
    ).resolves.toMatchObject({
      entries: expect.any(Array),
      truncated: true,
    });
    await expect(
      searchWorkspaceText(root, "a", { maxMatches: 1 }),
    ).resolves.toMatchObject({
      matches: expect.any(Array),
      truncated: true,
    });
  });

  it("bounds aggregate list and search output, not only item counts", async () => {
    const listed = await listWorkspaceFiles(root, ".", { maxOutputChars: 10 });
    expect(listed.entries.join("\n").length).toBeLessThanOrEqual(10);
    expect(listed.truncated).toBe(true);

    const searched = await searchWorkspaceText(root, "a", {
      maxOutputChars: 60,
    });
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

  // The serialized result is a JSON array, so the two brackets are part of the
  // payload the caller has to carry. Budgeting only the objects and their
  // separating commas lets the result exceed maxOutputChars.
  it("counts the JSON array brackets in the search output budget", async () => {
    fs.writeFileSync(path.join(root, "docs", "hit.txt"), "needle\n");

    const one = await searchWorkspaceText(root, "needle", {
      maxOutputChars: Number.MAX_SAFE_INTEGER,
    });
    expect(one.matches).toHaveLength(1);
    const exact = JSON.stringify(one.matches).length;

    // At exactly the serialized length the single match still fits.
    await expect(
      searchWorkspaceText(root, "needle", { maxOutputChars: exact }),
    ).resolves.toMatchObject({ matches: one.matches });

    // One character short it does not, and the result says so.
    await expect(
      searchWorkspaceText(root, "needle", { maxOutputChars: exact - 1 }),
    ).resolves.toMatchObject({ matches: [], truncated: true });
  });

  it("skips cyclic, broken, and escaping symlinks while listing", async () => {
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "workspace-outside-"),
    );
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync("..", path.join(root, "docs", "cycle"));
    fs.symlinkSync(
      path.join(outside, "secret.txt"),
      path.join(root, "docs", "outside"),
    );
    fs.symlinkSync("missing.txt", path.join(root, "docs", "broken"));

    const listed = await listWorkspaceFiles(root);

    expect(listed.entries).toEqual(["docs/image.bin", "docs/readme.txt"]);
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
