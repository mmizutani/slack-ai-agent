import {
  destroyThreadWorkspace,
  provisionThreadWorkspace,
} from "../config";
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

  cleanupInactiveSessions(
    maxAge: number = DEFAULT_SESSION_MAX_AGE_MS,
  ): void {
    const now = this.now().getTime();
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastActivity.getTime() > maxAge) {
        this.sessions.delete(key);
        this.destroyWorkspace(key);
      }
    }
  }
}
