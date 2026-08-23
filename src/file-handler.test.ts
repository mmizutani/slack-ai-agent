jest.mock("./config", () => ({
  config: { slack: { botToken: "test" } },
}));

import path from "path";
import fs from "fs";
import os from "os";
import { getUploadPath, FileHandler } from "./file-handler";

it("keeps upload names inside the thread workspace", () => {
  const workspace = "/tmp/thread-workspace";
  const uploadPath = getUploadPath(workspace, "../../other-thread/file.png");

  expect(path.dirname(uploadPath)).toBe(workspace);
  expect(path.basename(uploadPath)).toMatch(/-file\.png$/);
});

it("describes uploaded files with provider-neutral workspace guidance", () => {
  const handler = Object.create(FileHandler.prototype) as FileHandler;
  const result = handler.formatFilesOnly([
    {
      name: "notes.txt",
      mimetype: "text/plain",
      size: 12,
      path: "/tmp/thread-workspace/notes.txt",
      isImage: false,
    } as any,
  ]);

  expect(result).toContain("available in this conversation workspace");
  expect(result).toContain("workspace-reading tool");
  expect(result).not.toContain("Read tool");
});

it("advertises uploaded files with safe workspace-relative paths when requested", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "file-prompt-"));
  const absolutePath = path.join(workspace, "notes.txt");
  fs.writeFileSync(absolutePath, "notes");
  const handler = Object.create(FileHandler.prototype) as FileHandler;

  const result = handler.formatFilesOnly(
    [
      {
        name: "notes.txt",
        mimetype: "text/plain",
        size: 5,
        path: absolutePath,
      },
    ],
    workspace,
  );

  expect(result).toContain("`notes.txt`");
  expect(result).not.toContain(absolutePath);
});
