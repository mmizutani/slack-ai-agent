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

describe("materialise when a write fails part way", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-config-fail-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("restores files already written before rethrowing", async () => {
    // materialise writes into the deployment's own config directory. A failure
    // half way through used to leave the earlier files overwritten with no
    // handle to restore them, because the caller never received one.
    const good = path.join(dir, "first.yaml");
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(good, "original\n");
    fs.writeFileSync(blocker, "not a directory");
    const doomed = path.join(blocker, "second.yaml");

    await expect(
      materialise([
        { path: good, content: "replaced\n" },
        { path: doomed, content: "never\n" },
      ]),
    ).rejects.toThrow();

    expect(fs.readFileSync(good, "utf-8")).toBe("original\n");
  });

  it("removes a file it created before the failure", async () => {
    const created = path.join(dir, "created.yaml");
    const blocker = path.join(dir, "blocker2");
    fs.writeFileSync(blocker, "not a directory");

    await expect(
      materialise([
        { path: created, content: "new\n" },
        { path: path.join(blocker, "x.yaml"), content: "never\n" },
      ]),
    ).rejects.toThrow();

    expect(fs.existsSync(created)).toBe(false);
  });
});

describe("materialise when a restore fails", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-config-restore-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("restores the remaining files and reports the failure", async () => {
    // One unrestorable file must not strand the others: the operator's other
    // config would silently stay overwritten while the run reported nothing.
    const blocked = path.join(dir, "blocked.yaml");
    const other = path.join(dir, "other.yaml");
    fs.writeFileSync(blocked, "blocked-original\n");
    fs.writeFileSync(other, "other-original\n");

    const handle = await materialise([
      { path: blocked, content: "tmp-a\n" },
      { path: other, content: "tmp-b\n" },
    ]);

    // Make writing back to the first path impossible.
    fs.rmSync(blocked);
    fs.mkdirSync(blocked);

    await expect(handle.restore()).rejects.toThrow(/could not restore/);
    expect(fs.readFileSync(other, "utf-8")).toBe("other-original\n");
  });
});
