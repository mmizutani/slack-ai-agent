import fs from "fs";
import path from "path";
import { z } from "zod";
import { resolveWorkspacePath, workspaceRelativePath } from "./path-policy";

export interface WorkspaceToolLimits {
  maxFileBytes?: number;
  maxOutputChars?: number;
  maxEntries?: number;
  maxMatches?: number;
  maxTraversalEntries?: number;
}

/** Both brackets of the JSON array a bounded result is serialized into. */
const JSON_ARRAY_BRACKETS = 2;

const DEFAULT_LIMITS: Required<WorkspaceToolLimits> = {
  maxFileBytes: 1_000_000,
  maxOutputChars: 20_000,
  maxEntries: 200,
  maxMatches: 100,
  maxTraversalEntries: 2_000,
};

function limits(
  overrides?: WorkspaceToolLimits,
): Required<WorkspaceToolLimits> {
  return { ...DEFAULT_LIMITS, ...overrides };
}

/**
 * Escaped length of `text` as it appears inside a JSON string, excluding the
 * enclosing quotes. buildWorkspaceTools serializes every result with
 * JSON.stringify and escaping expands: a control character becomes six
 * characters, a quote or backslash two.
 */
function escapedLength(text: string): number {
  return JSON.stringify(text).length - 2;
}

/**
 * Longest prefix of `text` whose escaped form fits `maxChars`.
 *
 * The limit counts the characters the caller actually receives, so plain ASCII
 * costs exactly its length — unchanged — while escape expansion is now charged
 * for. Without this a file of control characters passed a 20,000-character
 * limit and serialized to roughly 120,000.
 */
function boundSerialized(text: string, maxChars: number): string {
  if (escapedLength(text) <= maxChars) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (escapedLength(text.slice(0, mid)) <= maxChars) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}

function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return sample.includes(0);
}

export type WorkspaceReadResult =
  | { kind: "text"; path: string; content: string; truncated: boolean }
  | { kind: "binary"; path: string; size: number; message: string };

export async function readWorkspaceFile(
  root: string,
  requestedPath: string,
  overrides?: WorkspaceToolLimits,
): Promise<WorkspaceReadResult> {
  const config = limits(overrides);
  const resolved = resolveWorkspacePath(root, requestedPath);
  const relative = workspaceRelativePath(root, resolved);
  // Open once and validate the descriptor. Separate stat and readFile calls
  // each resolve the path again, so the file whose type and size were checked
  // need not be the file that is read.
  const handle = await fs.promises.open(resolved, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Workspace path is not a file");
    if (stat.size > config.maxFileBytes) {
      return {
        kind: "binary",
        path: relative,
        size: stat.size,
        message: `File exceeds the ${config.maxFileBytes}-byte workspace limit.`,
      };
    }
    const buffer = await handle.readFile();
    if (isBinary(buffer)) {
      return {
        kind: "binary",
        path: relative,
        size: stat.size,
        message: "Binary files are not readable by the text workspace tool.",
      };
    }
    const text = buffer.toString("utf8");
    const content = boundSerialized(text, config.maxOutputChars);
    return {
      kind: "text",
      path: relative,
      content,
      truncated: content.length < text.length,
    };
  } finally {
    await handle.close();
  }
}

export async function listWorkspaceFiles(
  root: string,
  requestedPath = ".",
  overrides?: WorkspaceToolLimits,
): Promise<{ entries: string[]; truncated: boolean }> {
  const config = limits(overrides);
  const start = resolveWorkspacePath(root, requestedPath);
  const entries: string[] = [];
  const pending = [start];
  const visited = new Set<string>();
  let traversalTruncated = false;
  while (
    pending.length > 0 &&
    entries.length <= config.maxEntries &&
    visited.size < config.maxTraversalEntries
  ) {
    const current = pending.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const stat = await fs.promises.stat(current);
    if (!stat.isDirectory()) {
      entries.push(workspaceRelativePath(root, current));
      continue;
    }
    const children = await fs.promises.readdir(current);
    for (const child of children) {
      if (visited.size + pending.length >= config.maxTraversalEntries) {
        traversalTruncated = true;
        break;
      }
      const childPath = path.join(current, child);
      try {
        // Queue canonical paths so symlink cycles collapse in `visited`.
        pending.push(
          resolveWorkspacePath(root, workspaceRelativePath(root, childPath)),
        );
      } catch {
        // Broken and escaping symlinks are not workspace entries.
      }
    }
  }
  const boundedEntries: string[] = [];
  // Entries are returned as a JSON array, so the two brackets are part of the
  // payload and each path costs its escaped length, not its decoded length.
  let outputChars = JSON_ARRAY_BRACKETS;
  let outputTruncated = false;
  for (const entry of entries.slice(0, config.maxEntries)) {
    const separator = boundedEntries.length > 0 ? 1 : 0;
    const cost = separator + JSON.stringify(entry).length;
    if (outputChars + cost > config.maxOutputChars) {
      outputTruncated = true;
      break;
    }
    boundedEntries.push(entry);
    outputChars += cost;
  }
  const truncated =
    traversalTruncated ||
    pending.length > 0 ||
    entries.length > config.maxEntries ||
    outputTruncated;
  return { entries: boundedEntries, truncated };
}

export async function searchWorkspaceText(
  root: string,
  query: string,
  overrides?: WorkspaceToolLimits,
): Promise<{
  matches: Array<{ path: string; line: number; text: string }>;
  truncated: boolean;
}> {
  const config = limits(overrides);
  if (!query) return { matches: [], truncated: false };
  const listed = await listWorkspaceFiles(root, ".", {
    ...config,
    maxEntries: Math.max(config.maxEntries, config.maxMatches * 2),
    maxOutputChars: Number.MAX_SAFE_INTEGER,
  });
  const matches: Array<{ path: string; line: number; text: string }> = [];
  // The caller receives a JSON array, so the enclosing brackets are part of the
  // output being bounded; each match after the first also costs its comma.
  let outputChars = JSON_ARRAY_BRACKETS;
  let outputTruncated = false;
  for (const relative of listed.entries) {
    if (matches.length >= config.maxMatches || outputTruncated) break;
    const result = await readWorkspaceFile(root, relative, {
      maxFileBytes: config.maxFileBytes,
      maxOutputChars: config.maxFileBytes,
    });
    if (result.kind !== "text") continue;
    result.content.split(/\r?\n/).forEach((text, index) => {
      if (
        matches.length < config.maxMatches &&
        !outputTruncated &&
        text.includes(query)
      ) {
        const boundedText = text.slice(0, 1000);
        const candidate = {
          path: relative,
          line: index + 1,
          text: boundedText,
        };
        const candidateChars =
          JSON.stringify(candidate).length + (matches.length > 0 ? 1 : 0);
        if (outputChars + candidateChars > config.maxOutputChars) {
          outputTruncated = true;
          return;
        }
        matches.push(candidate);
        outputChars += candidateChars;
      }
    });
  }
  return {
    matches,
    truncated:
      listed.truncated ||
      matches.length >= config.maxMatches ||
      outputTruncated,
  };
}

/** Provider-neutral function definitions; runtime adapters construct SDK tools. */
export interface WorkspaceToolDefinition {
  name:
    | "workspace_read_file"
    | "workspace_list_files"
    | "workspace_search_text";
  description: string;
  parameters: unknown;
  execute(input: unknown): Promise<string>;
}

export function buildWorkspaceTools(
  root: string,
  overrides?: WorkspaceToolLimits,
): WorkspaceToolDefinition[] {
  return [
    {
      name: "workspace_read_file",
      description: "Read a bounded text file from the current Slack workspace.",
      parameters: z.object({ path: z.string() }),
      execute: async (input: any) =>
        JSON.stringify(await readWorkspaceFile(root, input.path, overrides)),
    },
    {
      name: "workspace_list_files",
      description: "List bounded entries in the current Slack workspace.",
      parameters: z.object({ path: z.string().optional() }),
      execute: async (input: any) =>
        JSON.stringify(
          await listWorkspaceFiles(root, input.path ?? ".", overrides),
        ),
    },
    {
      name: "workspace_search_text",
      description: "Search bounded text files in the current Slack workspace.",
      parameters: z.object({ query: z.string() }),
      execute: async (input: any) =>
        JSON.stringify(await searchWorkspaceText(root, input.query, overrides)),
    },
  ];
}
