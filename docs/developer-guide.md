# Developer Guide

This document covers the practical workflows for developing, testing, and verifying
the Slack AI Agent. It is written for developers and coding agents who need to
make changes confidently.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Development Environment](#development-environment)
- [Unit Tests](#unit-tests)
- [Live E2E Verification](#live-e2e-verification)
  - [Overview](#overview)
  - [What the Suite Verifies](#what-the-suite-verifies)
  - [Prerequisites](#prerequisites)
  - [Running the Suite](#running-the-suite)
  - [Understanding the Results](#understanding-the-results)
  - [Troubleshooting](#troubleshooting)
  - [Safety Rails](#safety-rails)
- [Architecture Overview](#architecture-overview)
- [Adding a New E2E Cycle](#adding-a-new-e2e-cycle)
- [Type Checking](#type-checking)

---

## Quick Start

```bash
# Install dependencies
pnpm install

# Set up configuration
cp .env.example .env
# → edit .env with your Slack tokens and provider API keys

# Set up config files
cp config/example-emojis.yaml config/emojis.yaml
cp config/example-tool-allowlist.yaml config/tool-allowlist.yaml
cp config/example-tool-denylist.yaml config/tool-denylist.yaml
cp config/instructions/example-general-context.txt config/instructions/general-context.txt

# Run unit tests
pnpm test

# Run type check
pnpm typecheck

# Run live E2E verification (against a real Slack workspace)
E2E_LIVE=1 pnpm e2e:live --channel C0123456789
```

---

## Development Environment

- **Node.js** ≥ 22
- **pnpm** 11.22+ (see `package.json` for the pinned version)
- **Slack workspace** with the app installed (see [README.md](../README.md#setup))
- **Provider API keys** for Anthropic and/or OpenAI

The project uses [tsx](https://tsx.is/) for development (auto-reload via `pnpm dev`)
and `tsc` for production builds.

---

## Unit Tests

Unit tests use [Jest](https://jestjs.io/) with `ts-jest` and live next to source
files as `*.test.ts`.

```bash
pnpm test                    # run all unit tests (serial)
pnpm exec jest --watch       # re-run on file changes
pnpm exec jest src/logger    # run tests matching a pattern
```

The unit suite is kept offline by `src/test-support/offline-guard.ts`, which
scrubs provider credentials and refuses outbound sockets so it can never bill a
provider or reach a real workspace.

---

## Live E2E Verification

### Overview

The `e2e/` directory contains an automated end-to-end verification suite that
drives the real Slack bot in a real Slack workspace, once per runtime (Anthropic
and OpenAI). It is intended to be run by a developer or coding agent after a
significant change to confirm the bot works in production conditions.

**Key properties:**

- Runs **unattended** — no manual Slack interaction required
- Asserts **deterministically** using per-run, per-cycle markers
- **Cleans up after itself** — deletes every message it created; restores any
  deployment config it modified
- **Exits non-zero** on any regression, with a machine-readable report
- **Costs a few cents** per full run — phases use the cheap model tier
- **Excluded from CI** — needs live credentials and spends provider money; it is
  a local and pre-release gate

### What the Suite Verifies

The suite runs **9 cycles** across **2 providers** (18 combinations total). Every
cycle derives a unique marker `E2E-<runId>-<cycleId>`, so no assertion depends
on model phrasing and a reply left over from an earlier run cannot satisfy a
later one.

| #   | Cycle               | What It Asserts                                                                                                                                 |
| --- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `channel-mention`   | A threaded reply in a public channel carries the marker; the app never logs `Failed to look up channel type` (guards the `channels:read` scope) |
| 2   | `dm`                | A reply in a DM channel opened with the bot token carries the marker                                                                            |
| 3   | `thread-continuity` | A follow-up in the same thread echoes a reference code only available from the first turn (proves session continuity)                           |
| 4   | `reactions`         | The terminal completion reaction (`white_check_mark`) appears on the user's message                                                             |
| 5   | `workspace-tool`    | The reply contains a seeded file's contents **and** the app recorded a non-zero tool-call count (proves file was read, not guessed)             |
| 6   | `mcp-tool`          | The reply contains a fixture MCP server's response format `MCP-OK-<code>`, which appears nowhere in the prompt                                  |
| 7   | `button-approval`   | The approval dialog is posted, the injected click runs the action, and its effect lands in the thread                                           |
| 8   | `cancellation`      | A burst of messages in one thread yields exactly one reply; the first turn was superseded or abandoned                                          |
| 9   | `provider-error`    | A failing provider is reported to the user (not swallowed); the fake endpoint is confirmed to have been called first                            |

### Prerequisites

#### 1. Slack App Scopes

The installed app must hold the following scopes in addition to the defaults:

- `channels:read`
- `groups:read`
- `groups:write`
- `chat:write.public`
- `files:read`

Add scopes at `https://api.slack.com/apps/<your-app-id>` → **OAuth & Permissions**
→ scroll to **Scopes** → **Add an OAuth Scope** → reinstall the app to the workspace.

Verify the scope works:

```bash
set -a; . ./.env; set +a
curl -s -H "Authorization: Bearer $CC_SLACK_BOT_TOKEN" \
  "https://slack.com/api/conversations.info?channel=$E2E_SLACK_CHANNEL_ID" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("ok"), d.get("error"), (d.get("channel") or {}).get("name"))'
```

Expected output: `True None <your-test-channel>`.

The `channel-mention` cycle guards this permanently by asserting the app never
logs `Failed to look up channel type`.

#### 2. Environment Variables

The suite reads these from `.env`:

| Variable                  | Purpose                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `CC_SLACK_BOT_TOKEN`      | Bot token (`xoxb-`). Reaction reads, `conversations.open`, bot-message cleanup.        |
| `CC_SLACK_APP_TOKEN`      | App-level token (`xapp-`). Socket Mode connection.                                     |
| `CC_SLACK_SIGNING_SECRET` | Signing secret for the Slack app.                                                      |
| `SLACK_MCP_XOXP_TOKEN`    | User token (`xoxp-`). **The driver** — holds `chat:write` to post and delete messages. |
| `ANTHROPIC_API_KEY`       | Required for the Anthropic runtime.                                                    |
| `OPENAI_API_KEY`          | Required for the OpenAI runtime.                                                       |

The suite also requires `E2E_LIVE=1` to be set (see [Safety Rails](#safety-rails)).

#### 3. Test Channel

Create a **dedicated** test channel in your Slack workspace. The channel name
must contain the word "test" as its own word (e.g. `#bot-testing`, `#e2e-test`,
`#test-channel`). The harness will refuse to run in any other channel.

The bot must be a **member** of the test channel (invite it via `/invite @<bot>`).

#### 4. Model Identifiers

The suite pins models in `e2e/lib/phase-env.ts`:

- Anthropic: `anthropic/claude-haiku-4-5`
- OpenAI: `openai/gpt-5.6-luna`

These are the cheap tier, deliberately chosen so the suite can be run often.
Ensure your `.env` does not override these with a model that does not exist —
the canonical ids use hyphens (e.g. `claude-haiku-4-5-20251001`).

### Running the Suite

#### Basic Usage

```bash
# Full matrix — both providers, all 9 cycles
E2E_LIVE=1 pnpm e2e:live --channel C0123456789
```

#### Command-Line Flags

| Flag                | Description                                                          |
| ------------------- | -------------------------------------------------------------------- |
| `--channel <id>`    | Target Slack channel (can also set `E2E_SLACK_CHANNEL_ID` in `.env`) |
| `--provider <name>` | Run only one provider (`anthropic` or `openai`). Repeatable.         |
| `--cycle <name>`    | Run only one cycle. Repeatable.                                      |
| `--timeout <ms>`    | Per-cycle timeout (default: 120000).                                 |
| `--keep`            | Leave messages in Slack for manual inspection after the run.         |

#### Common Commands

```bash
# Run only the OpenAI runtime
E2E_LIVE=1 pnpm e2e:live --channel C0123456789 --provider openai

# Run a single cycle
E2E_LIVE=1 pnpm e2e:live --channel C0123456789 --cycle mcp-tool

# Run a single cycle on a single provider
E2E_LIVE=1 pnpm e2e:live --channel C0123456789 --provider anthropic --cycle dm

# Leave messages for inspection
E2E_LIVE=1 pnpm e2e:live --channel C0123456789 --keep

# Increase timeout (useful when debugging slow cycles)
E2E_LIVE=1 pnpm e2e:live --channel C0123456789 --timeout 300000
```

#### What Happens During a Run

1. **Preflight check** — verifies credentials, channel membership, and that the
   channel name is safe.
2. **Fixture installation** — writes a temporary MCP config, tool allowlist, and
   workspace file. The original deployment config is captured and restored on
   teardown.
3. **Phase execution** — for each provider, for each host profile:
   - Forks a child process running the real Slack app via `e2e/agent-host.ts`
   - Waits for the child to become ready (Socket Mode connection)
   - Asserts only the expected provider is enabled
   - Runs each cycle in sequence
   - Collects logs from the child process
4. **Teardown** — deletes every message created during the run, restores
   deployment config, writes the report.

### Understanding the Results

#### Exit Codes

| Code | Meaning                                                           |
| ---- | ----------------------------------------------------------------- |
| 0    | All cycles passed, all skips documented, teardown clean           |
| 1    | Regression (failed cycle, undocumented skip, or teardown residue) |
| 2    | Preflight failure (bad args, missing credentials, wrong channel)  |

#### Run Output

```
run a1b2c3d4 → #bot-testing (C0123456789)  providers: anthropic, openai  cycles: channel-mention, dm, …
  … anthropic/channel-mention
  … anthropic/dm
  … anthropic/thread-continuity
  … openai/channel-mention
  …

  PASS  anthropic channel-mention      12345ms  reply ts 1712345678.901234
  PASS  anthropic dm                    23456ms  dm C0123456789 reply ts 1712345679.012345
  FAIL  openai   provider-error         78901ms  the bot replied but did not report a problem: …
      app said:
        [ERROR] Provider API returned 401
  …

  8 passed, 1 failed, 0 skipped
  report: e2e/report/a1b2c3d4.json
```

#### Report Files

- **`e2e/report/<runId>.json`** — machine-readable JSON with per-cycle status,
  provider, duration, evidence, and summary.
- **`e2e/report/<runId>-<phase>.log`** — raw output from the child process for
  each phase (e.g. `a1b2c3d4-anthropic-default.log`).

A failing cycle prints the app's own ERROR/WARN lines beneath its failure
message.

### Troubleshooting

#### All Cycles Fail with Timeout

- **Check the bot is a member of the test channel.** The preflight check catches
  this, but if the bot was removed after the check passed, cycles will time out
  because the bot never receives the messages.
- **Check Socket Mode is enabled** in the Slack app settings.
- **Check the app-level token** has `connections:write` scope.

#### Only Provider-Error Cycle Fails

- **Check the provider base URL.** The `provider-error` cycle points the
  provider's base URL at a local fake endpoint. If the override does not reach
  the SDK, the cycle answers normally and the assertion that the reply is an
  error message fails.
- **The cycle is slow by design** (up to 300s). The provider SDKs retry with
  backoff before surfacing a terminal error.

#### Only Button-Approval Cycle Fails

- **Check that the app's Interactivity is enabled** in the Slack app settings
  page. The cycle injects the click via Bolt's `processEvent` (which covers our
  handler chain), but Slack's actual delivery of the click requires Interactivity
  to be on for real users.
- **Check the fixture action was installed.** Run with `--cycle button-approval
--keep` and look at the thread to see if the approval dialog was posted.

#### Only Workspace-Tool or MCP-Tool Cycles Fail

- **Check the tool allowlist.** The harness writes a fixture allowlist, but if
  the original file was locked or the restore failed, the bot may not have the
  necessary grants.
- **Check the MCP server started.** The fixture MCP server is a stdio process
  spawned by the bot. If the bot's MCP configuration is broken, the server never
  starts.

#### "Failed to look up channel type" in Logs

The bot is missing the `channels:read` scope. Reinstall the app after adding the
scope (see [Prerequisites](#prerequisites)).

#### A Cycle Passes But the Report Shows "undocumented skip"

A cycle returned a `gap` string (indicating it was skipped intentionally) but
the gap description was empty. This is treated as a failure because the suite
cannot determine why the cycle was skipped.

#### "teardown: X message(s) left in Slack"

The harness could not delete some messages. This is treated as a failure because
a green run must leave the channel clean. Check that the driver token
(`SLACK_MCP_XOXP_TOKEN`) has `chat:write` and `chat:delete` scopes.

### Safety Rails

The suite has multiple layers of protection:

1. **`E2E_LIVE=1` guard** — refuses to run without this environment variable
   set, preventing accidental execution in CI.
2. **Channel name guard** — refuses any channel whose name does not contain
   "test" as its own word (e.g. `#bot-testing`, `#e2e-test`). Can be overridden
   with `E2E_SLACK_CHANNEL_ALLOWLIST` (comma-separated channel IDs) for
   workspaces whose disposable channel is not named for it.
3. **Bot membership check** — verifies the bot is a member of the target channel.
4. **Credential hygiene** — never prints a token, Authorization header, or raw
   provider payload.
5. **Automatic message deletion** — deletes every message the suite creates,
   including on failure and on SIGINT (`Ctrl-C`). Pass `--keep` to override.
6. **Deployment config restoration** — captures and restores any deployment
   config it modifies (tool allowlist, etc.).
7. **Rate-limit handling** — teardown honours `Retry-After` headers from
   `chat.delete`.
8. **Per-cycle timeouts** — every cycle has a bounded timeout, so a stalled
   provider SDK cannot hang the run indefinitely.

---

## Architecture Overview

### Directory Layout

```
src/                        # Production code
  app.ts                    # createApp() — exported for the harness
  index.ts                  # CLI entry point (thin)
e2e/                        # Live verification harness
  run.ts                    # Parent: CLI, phase matrix, report, exit code
  agent-host.ts             # Child: creates the app, listens for IPC commands
  lib/
    config.ts               # Flag parsing, preflight checks, guardrails
    markers.ts              # Per-run/per-cycle deterministic markers
    slack.ts                # Minimal Slack Web API client (fetch-based)
    host.ts                 # Child process management, log capture, teardown
    phase-env.ts            # Per-phase environment overlay (blanks other provider)
    block-actions.ts        # Button discovery and payload assembly for IPC
    cycle.ts                # Cycle context, assertion helpers, cleanup
    deployment-config.ts    # Temporarily materialise/restore config files
    fixtures.ts             # Fixture MCP config, allowlist, workspace file
    report.ts               # Result summarisation and exit code
  cycles/*.ts               # One file per cycle ID
  fixtures/
    echo-mcp-server.mjs     # stdio MCP server exposing e2e_echo tool
    fake-provider-server.ts # Local HTTP endpoint that fails every request
    actions/e2e-approval.ts # Approval-gated custom action for button-approval
```

### Child Process Per Provider

`src/config.ts` resolves the provider, default model and sandbox root as
module-level constants at import time, so two provider phases (Anthropic and
OpenAI) cannot share a process. The parent forks one child per phase via
`e2e/agent-host.ts`, establishing the single-provider startup path.

The environment variable `AGENT_DEFAULT_PROVIDER` is set per phase, and the
other provider's API key is **blanked** (not deleted) — see `phase-env.ts` for
why.

### IPC for Button Clicks

Slack exposes no Web API that originates a Block Kit button click. Bolt 4.7.3
exposes `processEvent` publicly, so the parent sends the child an IPC command
with the `block_actions` payload. The child feeds it into the real middleware
chain and the real `approve_action` handler. Its side effects (chat.update,
chat.postMessage) hit real Slack and are asserted there.

### Host Profiles

Cycles are grouped into three host profiles, each getting its own child process:

- **`default`** — fixture MCP server and workspace file, no custom actions
- **`actions`** — as `default`, plus the approval-gated fixture action
- **`failing-provider`** — provider base URL pointed at a local endpoint that
  fails every request

Isolation prevents the fixture action's `alwaysInject` tool from being offered
during unrelated cycles, which would cause non-deterministic failures.

---

## Adding a New E2E Cycle

1. **Create the cycle file** at `e2e/cycles/<name>.ts`. Export a `Cycle` object
   with:

   - `id` — unique string identifier
   - `describe` — one-line description for the report
   - `profile?` — host profile (`"default"`, `"actions"`, or `"failing-provider"`)
   - `timeoutMs?` — per-cycle timeout (only if slower than the default)
   - `run(ctx)` — the test logic

2. **Register the cycle** in `e2e/run.ts` by importing it and adding it to the
   `CYCLES` array.

3. **Use markers** for deterministic assertions: `ctx.marker()` returns a unique
   string the cycle can ask the bot to echo. Use `ctx.marker("suffix")` for
   secondary markers.

4. **Use the context helpers:**

   - `ctx.say(text)` — post as the driver (with @-mention)
   - `ctx.awaitBotReply(options)` — wait for a matching bot reply
   - `ctx.host` — access the child process (for IPC injection)
   - `ctx.fixtures` — access fixture configuration
   - `ctx.logsSinceStart()` — read the app's log output for this cycle

5. **Write unit tests** for any pure logic added to `e2e/lib/`. The `*.test.ts`
   files in `e2e/` run in normal CI.

6. **Run the new cycle alone** to verify it works:
   ```bash
   E2E_LIVE=1 pnpm e2e:live --channel C0123456789 --cycle <name>
   ```

---

## Type Checking

```bash
pnpm typecheck
```

Uses `tsc -p tsconfig.test.json --noEmit`. Always run before submitting a PR.
