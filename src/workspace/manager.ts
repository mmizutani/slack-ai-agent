import type { ConversationSession } from "../types";
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  searchWorkspaceText,
  type WorkspaceReadResult,
  type WorkspaceToolLimits,
} from "./tools";

/** Provider-neutral facade for one session's bounded workspace. */
export class WorkspaceManager {
  constructor(
    readonly root: string,
    private readonly limits?: WorkspaceToolLimits,
  ) {}

  static forSession(session: ConversationSession, limits?: WorkspaceToolLimits): WorkspaceManager {
    return new WorkspaceManager(session.workingDirectory, limits);
  }

  readFile(path: string): Promise<WorkspaceReadResult> {
    return readWorkspaceFile(this.root, path, this.limits);
  }

  listFiles(path = ".") {
    return listWorkspaceFiles(this.root, path, this.limits);
  }

  searchText(query: string) {
    return searchWorkspaceText(this.root, query, this.limits);
  }
}
