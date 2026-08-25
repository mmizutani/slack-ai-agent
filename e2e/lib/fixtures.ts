import fs from "fs";
import os from "os";
import path from "path";
import { materialise, type Materialised } from "./deployment-config";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

export const FIXTURE_MCP_SERVER_NAME = "e2e-fixtures";
export const FIXTURE_MCP_TOOL = "e2e_echo";
export const FIXTURE_ACTION_NAME = "e2e_record_code";
export const FIXTURE_ACTIONS_DIR = path.join(
  REPO_ROOT,
  "e2e",
  "fixtures",
  "actions",
);

/**
 * Tools the verification cycles need, as a single role.
 *
 * One role only, and deliberately: the driver's messages carry bot_id, so
 * ClaudeHandler resolves the role via getHighestRole(), which returns the last
 * key in this file. A second role would make which tools are granted depend on
 * key order rather than on this list.
 *
 * Both spellings of each capability appear because the runtimes disagree: the
 * Anthropic path grants its native tool names, the OpenAI path the
 * provider-neutral workspace aliases.
 */
export const FIXTURE_ALLOWLIST = `# Written by the live verification harness. Restored on teardown.
verification:
  - workspace/read_file
  - workspace/list_files
  - workspace/search_text
  - Read
  - Glob
  - Grep
  - mcp__${FIXTURE_MCP_SERVER_NAME}__${FIXTURE_MCP_TOOL}
  - mcp__custom-actions__${FIXTURE_ACTION_NAME}
  - action:custom-actions/${FIXTURE_ACTION_NAME}
`;

export interface FixtureSet {
  mcpConfigPath: string;
  customActionsDir: string;
  /** Path, relative to the agent workspace, of the seeded file. */
  workspaceFileRelPath: string;
  workspaceFileContent: string;
  cleanUp(): Promise<void>;
}

/**
 * Put the fixture configuration in place for a run.
 *
 * The MCP config lives in a temp directory and is reached through
 * MCP_CONFIG_PATH, so the deployment's own mcp-servers.json — which may hold
 * real credentials — is never touched. The tool allowlist has no such override
 * and must be written into config/, so it goes through materialise() and is
 * restored afterwards.
 */
export async function installFixtures(runId: string): Promise<FixtureSet> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-${runId}-`));

  const mcpConfigPath = path.join(tmpDir, "mcp-servers.json");
  fs.writeFileSync(
    mcpConfigPath,
    JSON.stringify(
      {
        mcpServers: {
          [FIXTURE_MCP_SERVER_NAME]: {
            command: process.execPath,
            args: [
              path.join(REPO_ROOT, "e2e", "fixtures", "echo-mcp-server.mjs"),
            ],
          },
        },
      },
      null,
      2,
    ),
  );

  // data/ is copied into every per-thread agent workspace, so a file dropped
  // here is what the workspace tools can actually reach. It is gitignored
  // except for example-*.yaml, so nothing here can be committed by accident.
  const workspaceFileRelPath = `data/e2e-${runId}.txt`;
  const workspaceFileContent = `WORKSPACE-OK-${runId}\n`;
  const workspaceFileAbs = path.join(REPO_ROOT, workspaceFileRelPath);

  const restorable: Materialised = await materialise([
    {
      path: path.join(REPO_ROOT, "config", "tool-allowlist.yaml"),
      content: FIXTURE_ALLOWLIST,
    },
    { path: workspaceFileAbs, content: workspaceFileContent },
  ]);

  return {
    mcpConfigPath,
    customActionsDir: FIXTURE_ACTIONS_DIR,
    workspaceFileRelPath,
    workspaceFileContent,
    cleanUp: async () => {
      await restorable.restore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
