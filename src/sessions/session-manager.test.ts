jest.mock("../config", () => ({
  provisionThreadWorkspace: jest.fn(
    (sessionKey: string) => `/tmp/slack-ai-agent/workspaces/${sessionKey}`,
  ),
  destroyThreadWorkspace: jest.fn(),
}));

import { destroyThreadWorkspace, provisionThreadWorkspace } from "../config";
import { SessionManager } from "./session-manager";

describe("SessionManager", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("keys sessions deterministically and keeps provider state separate", () => {
    const manager = new SessionManager();

    expect(manager.getSessionKey("U1", "C2", "111.222")).toBe(
      "U1-C2-111.222",
    );
    expect(manager.getSessionKey("U1", "C2")).toBe("U1-C2-direct");

    const session = manager.createSession("U1", "C2", "111.222");
    session.providerState.anthropic = { provider: "anthropic", sessionId: "a1" };
    session.providerState.openai = {
      provider: "openai",
      mode: "previous_response_id",
      previousResponseId: "r1",
    };

    expect(manager.getSession("U1", "C2", "111.222")).toBe(session);
    expect(session.providerState.anthropic?.sessionId).toBe("a1");
    expect(session.providerState.openai?.previousResponseId).toBe("r1");
    expect(provisionThreadWorkspace).toHaveBeenCalledWith("U1-C2-111.222");
  });

  it("removes inactive sessions and their workspaces", () => {
    const manager = new SessionManager();
    const session = manager.createSession("U1", "C2", "111.222");
    session.lastActivity = new Date(0);

    manager.cleanupInactiveSessions(1);

    expect(manager.getSession("U1", "C2", "111.222")).toBeUndefined();
    expect(destroyThreadWorkspace).toHaveBeenCalledWith("U1-C2-111.222");
  });

  it("clears incompatible continuation state when the provider changes", () => {
    const manager = new SessionManager();
    const session = manager.createSession("U1", "C2", "111.222");
    session.activeProvider = "anthropic";
    session.providerState.anthropic = {
      provider: "anthropic",
      sessionId: "claude-session",
    };
    session.sessionId = "claude-session";

    expect(manager.activateProvider(session, "openai")).toBe(true);
    expect(session.activeProvider).toBe("openai");
    expect(session.providerState).toEqual({});
    expect(session.sessionId).toBeUndefined();

    session.providerState.openai = {
      provider: "openai",
      mode: "previous_response_id",
      previousResponseId: "response-1",
    };
    expect(manager.activateProvider(session, "openai")).toBe(false);
    expect(session.providerState.openai?.previousResponseId).toBe("response-1");
  });
});
