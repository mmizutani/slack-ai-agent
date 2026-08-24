import dotenv from "dotenv";
import { SlackApi } from "./slack";
import type { ProviderId } from "./report";
import { newRunId } from "./markers";

dotenv.config({ quiet: true });

export const ALL_PROVIDERS: ProviderId[] = ["anthropic", "openai"];

export interface HarnessConfig {
  runId: string;
  bot: SlackApi;
  driver: SlackApi;
  botToken: string;
  channelId: string;
  channelName: string;
  botUserId: string;
  driverUserId: string;
  teamId: string;
  providers: ProviderId[];
  onlyCycles?: string[];
  cycleTimeoutMs: number;
  keep: boolean;
}

export class PreflightError extends Error {}

interface Flags {
  channel?: string;
  providers: ProviderId[];
  cycles: string[];
  keep: boolean;
  timeoutMs?: number;
}

export function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = { providers: [], cycles: [], keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new PreflightError(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--channel":
        flags.channel = next();
        break;
      case "--provider": {
        const value = next();
        if (value !== "anthropic" && value !== "openai") {
          throw new PreflightError(`unknown provider: ${value}`);
        }
        flags.providers.push(value);
        break;
      }
      case "--cycle":
        flags.cycles.push(next());
        break;
      case "--timeout":
        flags.timeoutMs = Number(next());
        break;
      case "--keep":
        flags.keep = true;
        break;
      default:
        throw new PreflightError(`unknown flag: ${arg}`);
    }
  }
  return flags;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new PreflightError(`${name} is not set in .env`);
  return value;
}

/**
 * Resolve configuration and refuse to run against anything but a test channel.
 *
 * The identity values are derived from `auth.test` rather than configured, so
 * there is exactly one thing to get wrong — the channel — and it is checked
 * against the live workspace before a single message is sent.
 */
export async function resolveConfig(
  argv: readonly string[],
): Promise<HarnessConfig> {
  const flags = parseFlags(argv);

  if (process.env.E2E_LIVE !== "1") {
    throw new PreflightError(
      "refusing to run: set E2E_LIVE=1 to post real messages to a real workspace",
    );
  }

  const channelId = flags.channel ?? process.env.E2E_SLACK_CHANNEL_ID;
  if (!channelId) {
    throw new PreflightError(
      "no target channel: pass --channel <id> or set E2E_SLACK_CHANNEL_ID",
    );
  }

  const botToken = required("CC_SLACK_BOT_TOKEN");
  required("CC_SLACK_APP_TOKEN");
  required("CC_SLACK_SIGNING_SECRET");
  const driverToken = required("SLACK_MCP_XOXP_TOKEN");

  const bot = new SlackApi(botToken);
  const driver = new SlackApi(driverToken);

  const botIdentity = await bot.authTest();
  const driverIdentity = await driver.authTest();

  if (botIdentity.team_id !== driverIdentity.team_id) {
    throw new PreflightError(
      "bot and driver tokens belong to different workspaces",
    );
  }

  const channel = await bot.channelInfo(channelId);
  const channelName = channel.name ?? "";

  // The harness posts, reacts and deletes. Pointing it at a working channel
  // would be destructive, so the name must say it is disposable.
  if (!channelName.includes("test")) {
    throw new PreflightError(
      `refusing to run in #${channelName}: channel name must contain "test"`,
    );
  }
  if (channel.is_member !== true) {
    throw new PreflightError(`the bot is not a member of #${channelName}`);
  }

  return {
    runId: newRunId(),
    bot,
    driver,
    botToken,
    channelId,
    channelName,
    botUserId: botIdentity.user_id,
    driverUserId: driverIdentity.user_id,
    teamId: botIdentity.team_id,
    providers: flags.providers.length ? flags.providers : ALL_PROVIDERS,
    ...(flags.cycles.length ? { onlyCycles: flags.cycles } : {}),
    cycleTimeoutMs: flags.timeoutMs ?? 120_000,
    keep: flags.keep,
  };
}
