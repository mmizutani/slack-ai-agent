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

const CYCLES: Cycle[] = [channelMention, dm, threadContinuity, reactions];

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
): Promise<CycleResult[]> {
  const results: CycleResult[] = [];
  const host = await AgentHost.start({
    label: `${provider}-phase`,
    env: phaseEnv(process.env, { provider }),
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
      path.join(REPORT_DIR, `${config.runId}-${provider}.log`),
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

  const results: CycleResult[] = [];
  let teardownDone = false;
  const teardown = async (): Promise<void> => {
    if (teardownDone) return;
    teardownDone = true;
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
    for (const provider of config.providers) {
      results.push(...(await runPhase(config, provider, cycles, track)));
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
