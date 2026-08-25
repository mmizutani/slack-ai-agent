import { ChildProcess, spawn } from "child_process";
import path from "path";
import { pollUntil, sleep } from "./slack";

const HOST_ENTRY = path.resolve(__dirname, "..", "agent-host.ts");

export interface HostOptions {
  /** Full environment for the child. Not merged with the parent's. */
  env: NodeJS.ProcessEnv;
  /** Shown in harness output; never sent to Slack. */
  label: string;
  startupTimeoutMs?: number;
}

/**
 * A running Slack app in a child process.
 *
 * Output is buffered so a cycle can assert on what the app logged — notably
 * the absence of "Failed to look up channel type", which is how a missing
 * `channels:read` scope manifests: the app still replies, but treats a public
 * channel as a DM.
 */
export class AgentHost {
  private readonly chunks: string[] = [];
  private nextCommandId = 1;
  private readonly pending = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  private exited = false;
  private enabled: string[] = [];

  private constructor(
    private readonly child: ChildProcess,
    readonly label: string,
  ) {}

  static async start(options: HostOptions): Promise<AgentHost> {
    const child = spawn(process.execPath, ["--import", "tsx", HOST_ENTRY], {
      cwd: path.resolve(__dirname, "..", ".."),
      env: options.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    const host = new AgentHost(child, options.label);

    // Declared before any listener that closes over it: an 'error' can fire
    // synchronously on a failed spawn, and reading `fatal` from its temporal
    // dead zone would replace a useful message with a ReferenceError.
    let ready = false;
    let fatal: string | undefined;

    // Without an 'error' listener a spawn failure (a missing interpreter, a
    // permissions problem) is an uncaught exception in the parent rather than
    // a reported startup failure.
    child.on("error", error => {
      fatal = `child process error: ${error.message}`;
    });

    child.stdout?.on("data", d => host.chunks.push(String(d)));
    child.stderr?.on("data", d => host.chunks.push(String(d)));
    child.on("exit", () => {
      host.exited = true;
      for (const { reject } of host.pending.values()) {
        reject(new Error("agent host exited before replying"));
      }
      host.pending.clear();
    });

    child.on("message", (message: any) => {
      if (message?.type === "ready") {
        host.enabled = message.enabledProviders ?? [];
        ready = true;
      } else if (message?.type === "fatal") fatal = message.error;
      else if (message?.type === "result") {
        const waiter = host.pending.get(message.id);
        if (!waiter) return;
        host.pending.delete(message.id);
        if (message.ok) waiter.resolve();
        else waiter.reject(new Error(message.error));
      }
    });

    // Every failure path stops the child before rethrowing. The timeout path
    // used to do this and the fatal path did not, which is the kind of
    // asymmetry that leaves a stray process behind on exactly the runs where
    // nobody is watching.
    try {
      const started = await pollUntil(
        async () => {
          if (fatal) throw new Error(`agent host failed to start: ${fatal}`);
          if (host.exited) {
            throw new Error(
              `agent host exited during startup:\n${host.tail(2000)}`,
            );
          }
          return ready ? true : undefined;
        },
        { timeoutMs: options.startupTimeoutMs ?? 60_000, intervalMs: 250 },
      );

      if (!started) {
        throw new Error(
          `agent host did not become ready in time:\n${host.tail(2000)}`,
        );
      }
    } catch (error) {
      await host.stop();
      throw error;
    }
    return host;
  }

  /** Providers the child actually enabled, as resolved inside that process. */
  enabledProviders(): string[] {
    return [...this.enabled];
  }

  /** Everything the child has written so far. */
  logs(): string {
    return this.chunks.join("");
  }

  /** Index into the log stream, for asserting on a single cycle's output. */
  mark(): number {
    return this.logs().length;
  }

  logsSince(mark: number): string {
    return this.logs().slice(mark);
  }

  private tail(chars: number): string {
    const all = this.logs();
    return all.slice(Math.max(0, all.length - chars));
  }

  async waitForLog(pattern: RegExp, timeoutMs: number): Promise<boolean> {
    const found = await pollUntil(
      async () => (pattern.test(this.logs()) ? true : undefined),
      { timeoutMs, intervalMs: 500 },
    );
    return found === true;
  }

  /**
   * Deliver a Slack-shaped payload into the child's Bolt instance.
   *
   * Resolves once the child reports the middleware chain finished, so a cycle
   * can assert on the resulting Slack side effects without racing them.
   */
  async inject(
    body: Record<string, unknown>,
    timeoutMs = 60_000,
  ): Promise<void> {
    if (this.exited) throw new Error("agent host is not running");
    const id = this.nextCommandId++;

    return new Promise<void>((resolve, reject) => {
      // Bounded, because a cycle awaits this directly rather than through
      // awaitBotReply: a child that never replies would otherwise hang the
      // whole run with no timeout anywhere above it.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `agent host did not acknowledge the injected payload within ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      timer.unref();

      const finish = (act: () => void): void => {
        clearTimeout(timer);
        this.pending.delete(id);
        act();
      };

      this.pending.set(id, {
        resolve: () => finish(resolve),
        reject: error => finish(() => reject(error)),
      });

      // send() reports back two ways, and both were ignored: false for a
      // closed channel, and an error through the callback.
      const queued = this.child.send({ id, type: "inject", body }, error => {
        if (error) finish(() => reject(error));
      });
      if (!queued) {
        finish(() =>
          reject(new Error("agent host IPC channel refused the payload")),
        );
      }
    });
  }

  /** Ask the child to disconnect, then make sure it is gone. */
  async stop(): Promise<void> {
    if (this.exited) return;
    try {
      this.child.send({ id: this.nextCommandId++, type: "shutdown" });
    } catch {
      // Channel already closed; fall through to the signals below.
    }

    const stopped = await pollUntil(
      async () => (this.exited ? true : undefined),
      { timeoutMs: 10_000, intervalMs: 200 },
    );
    if (stopped) return;

    this.child.kill("SIGTERM");
    await sleep(2000);
    if (!this.exited) this.child.kill("SIGKILL");
  }
}
