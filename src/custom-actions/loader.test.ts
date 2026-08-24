import path from "path";
import { resolveActionsDir } from "./loader";

describe("resolveActionsDir", () => {
  const original = process.env.CUSTOM_ACTIONS_DIR;

  afterEach(() => {
    if (original === undefined) delete process.env.CUSTOM_ACTIONS_DIR;
    else process.env.CUSTOM_ACTIONS_DIR = original;
  });

  it("defaults to the repository custom-actions directory", () => {
    delete process.env.CUSTOM_ACTIONS_DIR;
    expect(resolveActionsDir()).toBe(path.resolve("config/custom-actions"));
  });

  it("honours CUSTOM_ACTIONS_DIR so a harness can supply fixture actions", () => {
    process.env.CUSTOM_ACTIONS_DIR = "/tmp/e2e-actions";
    expect(resolveActionsDir()).toBe(path.resolve("/tmp/e2e-actions"));
  });

  it("ignores an empty override rather than resolving to the process cwd", () => {
    process.env.CUSTOM_ACTIONS_DIR = "";
    expect(resolveActionsDir()).toBe(path.resolve("config/custom-actions"));
  });
});
