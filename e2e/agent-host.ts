/**
 * Child process that hosts a real Slack app for one verification phase.
 *
 * Runs in its own process because `src/config.ts` evaluates the provider,
 * default model and sandbox root as module-level constants at import time — two
 * provider phases cannot share one process. Booting per phase also exercises
 * the single-provider startup path the OpenAI design doc lists as an exit
 * criterion.
 *
 * The parent talks to it over Node IPC. The only command that matters is
 * `inject`: Slack offers no Web API that originates a Block Kit click, so the
 * parent hands over the `block_actions` body Slack would have sent and this
 * process feeds it to Bolt's public `processEvent`.
 */
import { startApp, type WiredApp } from "../src/app";

type HostCommand =
  | { id: number; type: "inject"; body: Record<string, unknown> }
  | { id: number; type: "shutdown" };

type HostReply =
  | { type: "ready"; enabledProviders: string[] }
  | { type: "result"; id: number; ok: true }
  | { type: "result"; id: number; ok: false; error: string }
  | { type: "fatal"; error: string };

function send(reply: HostReply): void {
  process.send?.(reply);
}

async function main(): Promise<void> {
  let wired: WiredApp;
  try {
    wired = await startApp();
  } catch (error) {
    send({
      type: "fatal",
      error: error instanceof Error ? error.message : "unknown startup failure",
    });
    process.exit(1);
  }

  process.on("message", (command: HostCommand) => {
    void (async () => {
      try {
        if (command.type === "inject") {
          // `ack` is what Slack's servers would normally receive. Bolt requires
          // it, and an un-acked interaction never reaches the action handler.
          await wired.app.processEvent({
            body: command.body,
            ack: async () => undefined,
          });
          send({ type: "result", id: command.id, ok: true });
          return;
        }

        if (command.type === "shutdown") {
          await wired.app.stop().catch(() => undefined);
          send({ type: "result", id: command.id, ok: true });
          process.exit(0);
        }
      } catch (error) {
        send({
          type: "result",
          id: command.id,
          ok: false,
          error: error instanceof Error ? error.message : "unknown error",
        });
      }
    })();
  });

  // If the parent dies without sending shutdown, the IPC channel closes but
  // this process keeps its Socket Mode connection and interval timers alive —
  // a stray bot instance still receiving Slack events with nobody watching.
  process.on("disconnect", () => {
    void wired.app
      .stop()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });

  send({ type: "ready", enabledProviders: wired.enabledProviders });
}

void main();
