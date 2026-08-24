import fs from "fs";
import os from "os";
import path from "path";
import { materialise } from "./deployment-config";

describe("materialise", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-config-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes a file that did not exist", async () => {
    const target = path.join(dir, "tool-allowlist.yaml");

    await materialise([{ path: target, content: "member: []\n" }]);

    expect(fs.readFileSync(target, "utf-8")).toBe("member: []\n");
  });

  it("removes a file it created when restoring", async () => {
    const target = path.join(dir, "tool-allowlist.yaml");

    const handle = await materialise([{ path: target, content: "x\n" }]);
    await handle.restore();

    expect(fs.existsSync(target)).toBe(false);
  });

  it("restores the operator's original content byte for byte", async () => {
    // The whole point: this writes into the deployment's own config directory.
    // Losing an operator's allowlist would be far worse than a failed test.
    const target = path.join(dir, "tool-allowlist.yaml");
    const original = "admin:\n  - Read\n";
    fs.writeFileSync(target, original);

    const handle = await materialise([
      { path: target, content: "member: []\n" },
    ]);
    expect(fs.readFileSync(target, "utf-8")).toBe("member: []\n");
    await handle.restore();

    expect(fs.readFileSync(target, "utf-8")).toBe(original);
  });

  it("restores every file even when one was already removed", async () => {
    const a = path.join(dir, "a.yaml");
    const b = path.join(dir, "b.yaml");
    fs.writeFileSync(b, "original-b\n");

    const handle = await materialise([
      { path: a, content: "a\n" },
      { path: b, content: "b\n" },
    ]);
    fs.rmSync(a);
    await handle.restore();

    expect(fs.existsSync(a)).toBe(false);
    expect(fs.readFileSync(b, "utf-8")).toBe("original-b\n");
  });

  it("does not overwrite later edits when restored a second time", async () => {
    // Teardown can run twice — once in the runner's finally block, once from
    // the interrupt handler. A second restore must be a no-op, not a rewind
    // that discards whatever the operator changed in between.
    const target = path.join(dir, "c.yaml");
    fs.writeFileSync(target, "keep\n");

    const handle = await materialise([{ path: target, content: "tmp\n" }]);
    await handle.restore();
    fs.writeFileSync(target, "edited-after-restore\n");
    await handle.restore();

    expect(fs.readFileSync(target, "utf-8")).toBe("edited-after-restore\n");
  });
});
