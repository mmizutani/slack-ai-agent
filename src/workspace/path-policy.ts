import fs from "fs";
import path from "path";

export class WorkspaceSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceSecurityError";
  }
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Resolve an existing path while rejecting traversal, absolute escape, and symlink escape. */
export function resolveWorkspacePath(
  workspaceRoot: string,
  requestedPath: string,
): string {
  if (typeof requestedPath !== "string" || requestedPath.includes("\0")) {
    throw new WorkspaceSecurityError("Invalid workspace path");
  }
  if (path.isAbsolute(requestedPath)) {
    throw new WorkspaceSecurityError("Absolute paths are not allowed");
  }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(requestedPath)) {
    throw new WorkspaceSecurityError("Workspace path traversal is not allowed");
  }

  let root: string;
  try {
    root = fs.realpathSync.native(workspaceRoot);
  } catch (error) {
    throw new WorkspaceSecurityError("Workspace root is unavailable");
  }
  const candidate = path.resolve(root, requestedPath || ".");
  if (!within(root, candidate)) {
    throw new WorkspaceSecurityError("Path escapes the workspace");
  }
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(candidate);
  } catch {
    throw new WorkspaceSecurityError("Workspace path does not exist");
  }
  if (!within(root, resolved)) {
    throw new WorkspaceSecurityError("Symlink escapes the workspace");
  }
  return resolved;
}

export function workspaceRelativePath(root: string, resolvedPath: string): string {
  return path.relative(fs.realpathSync.native(root), resolvedPath) || ".";
}
