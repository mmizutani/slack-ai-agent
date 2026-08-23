import fs from "fs";
import os from "os";
import path from "path";
import { WorkspaceManager } from "./manager";

describe("WorkspaceManager", () => {
  it("binds all operations to one session workspace root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-manager-"));
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-other-"));
    fs.writeFileSync(path.join(root, "note.txt"), "hello");
    fs.writeFileSync(path.join(otherRoot, "secret.txt"), "secret");
    const manager = new WorkspaceManager(root);

    await expect(manager.readFile("note.txt")).resolves.toMatchObject({
      kind: "text",
      content: "hello",
    });
    await expect(manager.readFile("/etc/passwd")).rejects.toThrow();
    await expect(manager.readFile(path.join(otherRoot, "secret.txt"))).rejects.toThrow();
  });
});
