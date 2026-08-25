import fs from "fs";
import path from "path";

export interface MaterialisedFile {
  path: string;
  content: string;
}

export interface Materialised {
  /** Put every touched path back exactly as it was found. Idempotent. */
  restore(): Promise<void>;
}

/**
 * Temporarily place deployment-local configuration for a verification run.
 *
 * Some behaviour cannot be verified without it. config/tool-allowlist.yaml, for
 * instance, has no example fallback by design — an allowlist grants
 * permissions — so with no file the bot correctly grants no tools and the tool
 * cycles have nothing to exercise.
 *
 * Every original is captured before anything is written, and restore() puts
 * them back, so a run cannot cost an operator their configuration.
 */
export async function materialise(
  files: readonly MaterialisedFile[],
): Promise<Materialised> {
  const originals = files.map(file => ({
    path: file.path,
    existed: fs.existsSync(file.path),
    content: fs.existsSync(file.path)
      ? fs.readFileSync(file.path, "utf-8")
      : undefined,
  }));

  let restored = false;

  // One unrestorable file must not strand the rest. Errors are collected and
  // reported after every entry has been attempted, because the caller needs to
  // know that config was left modified — silently swallowing them would be a
  // fail-open on the operator's own files.
  const putBack = (upTo: number): void => {
    const failures: string[] = [];
    for (const original of originals.slice(0, upTo)) {
      try {
        if (original.existed && original.content !== undefined) {
          fs.writeFileSync(original.path, original.content);
        } else {
          fs.rmSync(original.path, { force: true });
        }
      } catch (error) {
        failures.push(
          `${original.path}: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `could not restore ${failures.length} file(s): ${failures.join("; ")}`,
      );
    }
  };

  // Roll back on a partial failure. Without this the caller gets a throw and no
  // handle, so the files already overwritten stay overwritten — and these are
  // the operator's own config, not scratch files.
  for (const [index, file] of files.entries()) {
    try {
      fs.mkdirSync(path.dirname(file.path), { recursive: true });
      fs.writeFileSync(file.path, file.content);
    } catch (error) {
      try {
        putBack(index);
      } catch (restoreError) {
        // Surface both: the write failure explains why, the restore failure
        // says what was left behind.
        restored = true;
        throw new Error(
          `${error instanceof Error ? error.message : "write failed"} (and rollback failed: ${restoreError instanceof Error ? restoreError.message : "unknown"})`,
        );
      }
      restored = true;
      throw error;
    }
  }

  return {
    restore: async () => {
      if (restored) return;
      restored = true;
      putBack(originals.length);
    },
  };
}
