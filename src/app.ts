// config is imported first so dotenv.config() runs before any module reads
// process.env at import time.
import { config, validateEnabledProviders } from "./config";
import { App } from "@slack/bolt";
import { ClaudeHandler } from "./claude-handler";
import { SlackHandler } from "./slack-handler";
import { McpManager } from "./mcp-manager";
import { ReactionManager } from "./reaction-manager";
import { CustomActionRegistry, loadCustomActions } from "./custom-actions";
import { Logger } from "./logger";
import { UserUtils } from "./user-utils";
import { initTracking } from "./tracking";
import { ChannelConfigManager } from "./channel-config";
import { OpusHealthMonitor, buildSlackNotify } from "./opus-health";
import { SessionManager } from "./sessions/session-manager";
import { AgentRuntimeRegistry } from "./runtimes/registry";
import { ClaudeAgentRuntime } from "./runtimes/anthropic/runtime";
import { OpenAIAgentRuntime } from "./runtimes/openai/runtime";
import { loadSubagentDefinitions as loadProviderNeutralSubagentDefinitions } from "./subagents/loader";

const logger = new Logger("Main");

/**
 * Everything `createApp` wires together.
 *
 * Returned rather than kept private so an out-of-process verification harness
 * can reach the live `App` — notably to call Bolt's public `processEvent`, the
 * only way to exercise a Block Kit button click, for which Slack offers no
 * Web API.
 */
export interface WiredApp {
  app: App;
  registry: CustomActionRegistry;
  mcpManager: McpManager;
  sessionManager: SessionManager;
  runtimeRegistry: AgentRuntimeRegistry;
  slackHandler: SlackHandler;
  channelConfigManager: ChannelConfigManager;
  reactionManager: ReactionManager;
  customActionNames: string[];
  mcpServerNames: string[];
}

/**
 * Build and wire the Slack app without connecting to Slack.
 *
 * Split from `start` so the app can be constructed in a test or verification
 * process.
 *
 * Note that constructing a Bolt `App` is NOT free of network I/O: with the
 * default `tokenVerificationEnabled: true`, Bolt's `singleAuthorization` fires
 * `auth.test` immediately and leaves the promise floating, so an invalid token
 * surfaces as an unhandled rejection rather than a thrown error. Unit tests
 * therefore rely on `src/test-support/offline-guard.ts` to refuse the socket.
 */
export async function createApp(): Promise<WiredApp> {
  validateEnabledProviders({
    enabledProviders: config.agent.enabledProviders,
    smartReplyModel: config.smartReplyModel,
  });

  const app = new App({
    token: config.slack.botToken,
    signingSecret: config.slack.signingSecret,
    socketMode: true,
    appToken: config.slack.appToken,
  });

  const mcpManager = new McpManager();
  const mcpConfig = mcpManager.loadConfiguration();
  const channelConfigManager = new ChannelConfigManager();
  channelConfigManager.setApp(app);
  initTracking(app, channelConfigManager);

  const reactionManager = new ReactionManager(app);

  const registry = new CustomActionRegistry(app, reactionManager);
  const actions = await loadCustomActions();
  for (const action of actions) {
    registry.register(action);
  }
  registry.setupButtonHandlers();
  registry.startSessionCleanup();

  const opusHealthMonitor = new OpusHealthMonitor({
    notify: buildSlackNotify(app, config.opsAlertChannelId),
  });

  const sessionManager = new SessionManager();
  const runtimeRegistry = new AgentRuntimeRegistry();
  if (config.agent.enabledProviders.includes("anthropic")) {
    const claudeHandler = new ClaudeHandler(
      mcpManager,
      registry,
      opusHealthMonitor,
      sessionManager,
    );
    runtimeRegistry.register(new ClaudeAgentRuntime(claudeHandler));
  }
  if (config.agent.enabledProviders.includes("openai")) {
    runtimeRegistry.register(
      new OpenAIAgentRuntime({
        subagentDefinitions: loadProviderNeutralSubagentDefinitions(),
      }),
    );
  }
  const slackHandler = new SlackHandler(
    app,
    sessionManager,
    reactionManager,
    channelConfigManager,
    sessionManager,
    runtimeRegistry,
    registry,
    mcpManager,
  );
  slackHandler.setupEventHandlers();

  installSocketModeMonitoring(app);

  return {
    app,
    registry,
    mcpManager,
    sessionManager,
    runtimeRegistry,
    slackHandler,
    channelConfigManager,
    reactionManager,
    customActionNames: actions.map(action => action.name),
    mcpServerNames: mcpConfig ? Object.keys(mcpConfig.mcpServers) : [],
  };
}

function installSocketModeMonitoring(app: App): void {
  const receiver = (app as any).receiver;
  if (receiver && typeof receiver.on === "function") {
    receiver.on("disconnect", (error: any) => {
      logger.error("🔌 Socket Mode disconnected!", error);
    });

    receiver.on("close", (code: number, reason: string) => {
      logger.error("🔌 Socket Mode connection closed", { code, reason });
    });

    receiver.on("outgoing_error", (error: any) => {
      logger.error("🔌 Socket Mode outgoing error", error);
    });

    receiver.on("incoming_error", (error: any) => {
      logger.error("🔌 Socket Mode incoming error", error);
    });

    logger.info("🔌 Socket Mode monitoring enabled", {
      socketMode: true,
      appToken: config.slack.appToken ? "present" : "missing",
    });
  } else {
    logger.info(
      "🔌 Socket Mode monitoring not available (receiver.on not supported)",
      {
        socketMode: true,
        appToken: config.slack.appToken ? "present" : "missing",
      },
    );
  }
}

/** Startup banner. Readiness detection depends on this exact line. */
export const READY_LOG_MESSAGE = "⚡️ Slack AI agent is running!";

/** Wire the app, connect to Slack, and start background timers. */
export async function startApp(): Promise<WiredApp> {
  logger.info("Starting Slack AI agent app", {
    debug: config.debug,
    provider: config.agent.defaultProvider,
  });

  const wired = await createApp();

  await wired.app.start();
  UserUtils.startCleanupInterval();

  logger.info(READY_LOG_MESSAGE, {
    provider: config.agent.defaultProvider,
  });
  logger.info("Configuration:", {
    debugMode: config.debug,
    baseDirectory: config.baseDirectory,
    mcpServers: wired.mcpServerNames.length,
    mcpServerNames: wired.mcpServerNames,
    customActions: wired.customActionNames.length,
  });

  return wired;
}
