/**
 * Dynamic loader for custom actions.
 *
 * Scans config/custom-actions/ for TypeScript files, dynamically imports
 * each one, and returns the actions to register. Each file must default-export
 * an CustomAction instance.
 *
 * If the directory is empty or missing, returns an empty array and the bot
 * continues to work normally (just without custom actions).
 */

import fs from "fs";
import path from "path";
import { Logger } from "../logger";
import type { CustomAction } from "./types";

const logger = new Logger("CustomActions");

// Detect whether we're running from compiled JS (production) or TypeScript (dev)
const isCompiled = __filename.endsWith(".js");

// In compiled mode, config files live at dist/config/custom-actions/ relative
// to this file at dist/src/custom-actions/loader.js.
// In dev mode, config files live at config/custom-actions/ relative to CWD.
const defaultActionsDir = (): string =>
  isCompiled
    ? path.resolve(__dirname, "../../config/custom-actions")
    : path.resolve("config/custom-actions");

/**
 * Directory scanned for custom actions.
 *
 * `CUSTOM_ACTIONS_DIR` exists so an out-of-process harness can point the bot at
 * fixture actions without writing into `config/custom-actions/`, which is both
 * deployment-local and gitignored except for `example-*` files that this loader
 * deliberately skips. Resolved per call rather than at module load so a caller
 * can set it after this module is imported.
 *
 * An empty value is treated as unset: `path.resolve("")` is the process cwd,
 * which would silently scan the repository root.
 */
export const resolveActionsDir = (): string => {
  const override = process.env.CUSTOM_ACTIONS_DIR;
  return override ? path.resolve(override) : defaultActionsDir();
};

const CONFIG_EXT = isCompiled ? ".js" : ".ts";

/**
 * Discover and load all custom action files from config/custom-actions/.
 * Files that default-export an CustomAction instance are registered.
 * Files without a valid default export (e.g. utility modules) are silently skipped.
 */
export const loadCustomActions = async (): Promise<CustomAction<any>[]> => {
  const actionsDir = resolveActionsDir();
  if (!fs.existsSync(actionsDir)) {
    return [];
  }

  const files = fs.readdirSync(actionsDir).filter(
    f =>
      f.endsWith(CONFIG_EXT) &&
      !f.endsWith(".d.ts") &&
      // Test files live alongside source modules. Jest discovers them via
      // its testMatch glob; the loader must skip them or it'll try to
      // `import()` files whose top-level describe()/it() calls reference
      // Jest globals that aren't defined outside the test runner.
      !f.endsWith(".test.ts") &&
      !f.endsWith(".test.js") &&
      !f.startsWith("example-"),
  );

  if (files.length === 0) {
    return [];
  }

  const actions: CustomAction<any>[] = [];

  for (const file of files) {
    try {
      const filePath = path.join(actionsDir, file);
      const mod = await import(filePath);
      const action = mod.default;

      // Silently skip files without a valid CustomAction default export
      // (e.g. utility modules like temporal-utils.ts)
      if (!action || !action.name) {
        continue;
      }

      const requiresApproval = action.requiresApproval !== false;
      if (requiresApproval && !action.execute) {
        continue;
      }
      if (!requiresApproval && !action.invoke) {
        continue;
      }

      actions.push(action);
      logger.info(`Loaded custom action: ${action.name} (from ${file})`);
    } catch (error) {
      logger.error(`Failed to load custom action from ${file}:`, error);
    }
  }

  return actions;
};
