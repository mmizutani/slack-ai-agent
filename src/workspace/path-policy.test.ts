import fs from "fs";
import os from "os";
import path from "path";
import { resolveWorkspacePath } from "./path-policy";

describe("workspace path policy", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-policy-"));
    fs.mkdirSync(path.join(root, "nested"));
    fs.writeFileSync(path.join(root, "nested", "note.txt"), "hello");
  });

  it("resolves valid nested files under the real workspace root", () => {
    expect(resolveWorkspacePath(root, "nested/note.txt")).toBe(
      fs.realpathSync(path.join(root, "nested", "note.txt")),
    );
  });

  it.each(["../outside.txt", "nested/../../outside.txt", "/etc/passwd"])(
    "rejects traversal or absolute escape: %s",
    requested => {
      expect(() => resolveWorkspacePath(root, requested)).toThrow(/workspace|path|escape/i);
    },
  );

  it("rejects a symlink that resolves outside the workspace", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(outside, path.join(root, "escape"), "dir");

    expect(() => resolveWorkspacePath(root, "escape/secret.txt")).toThrow(/workspace|symlink|escape/i);
  });
});
