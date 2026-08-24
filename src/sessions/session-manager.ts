import { destroyThreadWorkspace, provisionThreadWorkspace } from "../config";
import {
  AgentProviderId,
  ConversationSession,
  ProviderSessionState,
} from "../types";

/** Default max age for inactive session cleanup (16 hours). */
export const DEFAULT_SESSION_MAX_AGE_MS = 16 * 60 * 60 * 1000;

export interface SessionManagerOptions {
  provisionWorkspace?: (sessionKey: string) => string;
  destroyWorkspace?: (sessionKey: string) => void;
  now?: () => Date;
}

/** Owns Slack conversation identity, workspace lifecycle, and provider state. */
export class SessionManager {
  private readonly sessions = new Map<string, ConversationSession>();
  /**
   * Workspace keys whose destruction failed. The session is already gone from
   * `sessions` — a half-cleaned session must not stay resumable — so this is
   * the only remaining handle on the directory left behind.
   */
  private readonly pendingWorkspaceCleanup = new Set<string>();
  private readonly provisionWorkspace: (sessionKey: string) => string;
  private readonly destroyWorkspace: (sessionKey: string) => void;
  private readonly now: () => Date;

  constructor(options: SessionManagerOptions = {}) {
    this.provisionWorkspace =
      options.provisionWorkspace ?? provisionThreadWorkspace;
    this.destroyWorkspace = options.destroyWorkspace ?? destroyThreadWorkspace;
    this.now = options.now ?? (() => new Date());
  }

  getSessionKey(userId: string, channelId: string, threadTs?: string): string {
    return `${userId}-${channelId}-${threadTs || "direct"}`;
  }

  getSession(
    userId: string,
    channelId: string,
    threadTs?: string,
  ): ConversationSession | undefined {
    return this.sessions.get(this.getSessionKey(userId, channelId, threadTs));
  }

  createSession(
    userId: string,
    channelId: string,
    threadTs?: string,
  ): ConversationSession {
    const sessionKey = this.getSessionKey(userId, channelId, threadTs);
    this.resolvePendingWorkspace(sessionKey);
    const session: ConversationSession = {
      userId,
      channelId,
      threadTs,
      providerState: {},
      workingDirectory: this.provisionWorkspace(sessionKey),
      lastActivity: this.now(),
    };
    this.sessions.set(sessionKey, session);
    return session;
  }

  touchSession(session: ConversationSession): void {
    session.lastActivity = this.now();
  }

  clearProviderState(
    session: ConversationSession,
    provider?: AgentProviderId,
  ): void {
    if (provider) {
      delete session.providerState[provider];
      if (provider === "anthropic") session.sessionId = undefined;
      return;
    }
    session.providerState = {};
    session.sessionId = undefined;
  }

  setProviderState(
    session: ConversationSession,
    state: ProviderSessionState,
  ): void {
    session.providerState[state.provider] = state;
    if (state.provider === "anthropic") {
      session.sessionId = state.sessionId;
    }
  }

  /** Activate a runtime, clearing opaque continuation state on provider change. */
  activateProvider(
    session: ConversationSession,
    provider: AgentProviderId,
  ): boolean {
    const changed =
      session.activeProvider !== undefined &&
      session.activeProvider !== provider;
    if (changed) this.clearProviderState(session);
    session.activeProvider = provider;
    return changed;
  }

  cleanupInactiveSessions(maxAge: number = DEFAULT_SESSION_MAX_AGE_MS): void {
    const now = this.now().getTime();
    for (const key of [...this.pendingWorkspaceCleanup]) {
      this.destroyWorkspaceOnce(key);
    }
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastActivity.getTime() > maxAge) {
        this.sessions.delete(key);
        this.destroyWorkspaceOnce(key);
      }
    }
  }

  /**
   * Settle a queued cleanup before its path is handed to a new session.
   *
   * Session keys are deterministic and the workspace path derives from the key,
   * so recreating a thread's session reuses the exact directory a failed
   * cleanup left queued. Try once more to clear it out, then drop the key
   * regardless: the path now belongs to a live conversation, and a sweep that
   * still held the key would delete that conversation's workspace.
   */
  private resolvePendingWorkspace(sessionKey: string): void {
    if (!this.pendingWorkspaceCleanup.has(sessionKey)) return;
    this.destroyWorkspaceOnce(sessionKey);
    this.pendingWorkspaceCleanup.delete(sessionKey);
  }

  /**
   * Destroy one workspace, keeping the key for a later sweep if it fails. The
   * sweep runs from a setInterval callback, so a failure must neither abandon
   * the remaining sessions nor escape as an unhandled exception — but it must
   * not be swallowed either, or the directory is left on disk for good.
   */
  private destroyWorkspaceOnce(sessionKey: string): void {
    try {
      this.destroyWorkspace(sessionKey);
      this.pendingWorkspaceCleanup.delete(sessionKey);
    } catch {
      this.pendingWorkspaceCleanup.add(sessionKey);
    }
  }
}
