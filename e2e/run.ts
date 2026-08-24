/**
 * Live end-to-end verification against a real Slack workspace.
 *
 * Runs the cycle set once per provider, each in its own child process, and
 * exits non-zero if anything regressed. Intended to be run by a coding agent
 * after changing this codebase: `E2E_LIVE=1 pnpm e2e:live --channel C…`.
 */
import fs from "fs";
import path from "path";
import {
  PreflightError,
  resolveConfig,
  type HarnessConfig,
} from "./lib/config";
import { AgentHost } from "./lib/host";
import { phaseEnv } from "./lib/phase-env";
import {
  cleanUp,
  makeContext,
  type Cycle,
  type CycleOutcome,
  type Trace,
} from "./lib/cycle";
import {
  formatSummary,
  summarize,
  type CycleResult,
  type ProviderId,
} from "./lib/report";
import { channelMention } from "./cycles/channel-mention";
import { dm } from "./cycles/dm";
import { threadContinuity } from "./cycles/thread-continuity";
import { reactions } from "./cycles/reactions";
import { cancellation } from "./cycles/cancellation";
import { providerError } from "./cycles/provider-error";
import { workspaceTool } from "./cycles/workspace-tool";
import { mcpTool } from "./cycles/mcp-tool";
import { buttonApproval } from "./cycles/button-approval";
import { startFakeProvider } from "./fixtures/fake-provider-server";
import { installFixtures, type FixtureSet } from "./lib/fixtures";

const CYCLES: Cycle[] = [
  channelMention,
  dm,
  threadContinuity,
  reactions,
  workspaceTool,
  mcpTool,
  buttonApproval,
  cancellation,
  providerError,
];

const REPORT_DIR = path.resolve(__dirname, "report");

function selected(config: HarnessConfig): Cycle[] {
  if (!config.onlyCycles) return CYCLES;
  const known = new Set(CYCLES.map(c => c.id));
  for (const id of config.onlyCycles) {
    if (!known.has(id)) {
      throw new PreflightError(
        `unknown cycle: ${id} (known: ${[...known].join(", ")})`,
      );
    }
  }
  return CYCLES.filter(c => config.onlyCycles!.includes(c.id));
}

async function runPhase(
  config: HarnessConfig,
  provider: ProviderId,
  cycles: readonly Cycle[],
  track: (trace: Trace) => void,
  options: {
    providerBaseUrl?: string;
    fakeProviderHits?: () => number;
    fixtures?: FixtureSet;
  } = {},
): Promise<CycleResult[]> {
  const results: CycleResult[] = [];
  const label = options.providerBaseUrl
    ? `${provider}-failing-provider`
    : `${provider}-phase`;
  const host = await AgentHost.start({
    label,
    env: phaseEnv(process.env, {
      provider,
      ...(options.providerBaseUrl
        ? { providerBaseUrl: options.providerBaseUrl }
        : {}),
      ...(options.fixtures
        ? {
            mcpConfigPath: options.fixtures.mcpConfigPath,
            customActionsDir: options.fixtures.customActionsDir,
          }
        : {}),
    }),
  });

  try {
    const enabled = host.enabledProviders();
    if (enabled.length !== 1 || enabled[0] !== provider) {
      // Not a cycle failure but a harness failure: every result from this
      // phase would be attributed to the wrong runtime.
      throw new Error(
        `phase isolation broke: expected only ${provider}, host enabled ${enabled.join(", ") || "nothing"}`,
      );
    }

    for (const cycle of cycles) {
      const started = Date.now();
      process.stdout.write(`  … ${provider}/${cycle.id}\n`);
      // Built outside the try so a failing cycle can still report what the app
      // logged. Debugging a silent non-reply without this is guesswork.
      const ctx = makeContext({
        config,
        host,
        provider,
        cycleId: cycle.id,
        track,
        ...(options.fakeProviderHits
          ? { fakeProviderHits: options.fakeProviderHits }
          : {}),
        ...(options.fixtures ? { fixtures: options.fixtures } : {}),
        ...(cycle.timeoutMs ? { timeoutMs: cycle.timeoutMs } : {}),
      });
      try {
        const outcome: CycleOutcome = await cycle.run(ctx);
        const gap = outcome && "gap" in outcome ? outcome.gap : undefined;
        results.push({
          cycleId: cycle.id,
          provider,
          status: gap ? "skipped" : "passed",
          durationMs: Date.now() - started,
          ...(gap ? { gap } : {}),
          ...(outcome && "evidence" in outcome && outcome.evidence
            ? { evidence: outcome.evidence }
            : {}),
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "unknown failure";
        results.push({
          cycleId: cycle.id,
          provider,
          status: "failed",
          durationMs: Date.now() - started,
          detail: message,
        });
        // Surface what the app said, not just that nothing arrived. The first
        // line mentioning ERROR or WARN is usually the whole story.
        const noisy = ctx
          .logsSinceStart()
          .split("\n")
          .filter(line => /\[(ERROR|WARN)\]/.test(line))
          .slice(-4);
        if (noisy.length) {
          console.log(`      app said:\n        ${noisy.join("\n        ")}`);
        }
      }
    }
  } finally {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(REPORT_DIR, `${config.runId}-${label}.log`),
      host.logs(),
    );
    await host.stop();
  }

  return results;
}

async function main(): Promise<void> {
  const config = await resolveConfig(process.argv.slice(2));
  const cycles = selected(config);
  const traces: Trace[] = [];
  const track = (trace: Trace): void => {
    traces.push(trace);
  };

  console.log(
    `run ${config.runId} → #${config.channelName} (${config.channelId})  providers: ${config.providers.join(", ")}  cycles: ${cycles.map(c => c.id).join(", ")}`,
  );

  // Installed for the whole run: the tool allowlist has no environment
  // override and must be written into config/, so it is put back on teardown.
  const fixtures = await installFixtures(config.runId);

  const results: CycleResult[] = [];
  let teardownDone = false;
  const teardown = async (): Promise<void> => {
    if (teardownDone) return;
    teardownDone = true;
    await fixtures.cleanUp();
    if (config.keep) {
      console.log(`\n--keep: left ${traces.length} messages in Slack`);
      return;
    }
    const removed = await cleanUp(traces, config.bot, config.driver);
    console.log(`\ncleaned up ${removed}/${traces.length} messages`);
  };

  // A killed run must not leave the channel dirty.
  process.on("SIGINT", () => {
    void teardown().then(() => process.exit(130));
  });

  try {
    const normal = cycles.filter(c => !c.needsFakeProvider);
    const failing = cycles.filter(c => c.needsFakeProvider);

    for (const provider of config.providers) {
      if (normal.length) {
        results.push(
          ...(await runPhase(config, provider, normal, track, { fixtures })),
        );
      }
      if (failing.length) {
        // Its own host: the base URL override is process-wide, so it cannot
        // share a process with cycles that need the provider to work.
        const fake = await startFakeProvider();
        try {
          results.push(
            ...(await runPhase(config, provider, failing, track, {
              providerBaseUrl: fake.url,
              fakeProviderHits: fake.hits,
            })),
          );
        } finally {
          await fake.close();
        }
      }
    }
  } finally {
    await teardown();
  }

  const summary = summarize(results);
  console.log("");
  console.log(formatSummary(results, summary));

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `${config.runId}.json`);
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        runId: config.runId,
        channel: { id: config.channelId, name: config.channelName },
        providers: config.providers,
        results,
        summary,
      },
      null,
      2,
    ),
  );
  console.log(`\nreport: ${reportPath}`);
  process.exit(summary.exitCode);
}

main().catch(error => {
  if (error instanceof PreflightError) {
    console.error(`preflight: ${error.message}`);
    process.exit(2);
  }
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
