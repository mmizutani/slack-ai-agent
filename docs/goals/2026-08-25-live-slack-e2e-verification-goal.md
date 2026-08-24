# Goal: Automated Live-Slack End-to-End Verification for Both Runtimes

> **For agentic workers:** This document is the complete brief. Everything you
> need — workspace identifiers, credential names, broken preconditions, file
> seams, and the acceptance gate — is stated here or reachable from a path named
> here. Do not ask the human for missing context; probe the repository and the
> live APIs instead.
>
> REQUIRED SUB-SKILLS: `superpowers:test-driven-development` for every pure
> module you add, and `superpowers:verification-before-completion` before you
> claim any part of this done.

**Goal:** Give this repository an automated end-to-end verification cycle that
exercises the real Slack agent, in a real Slack workspace, against both the
Anthropic and the OpenAI runtime — so that a coding agent changing this codebase
can prove its change works in production conditions without a human driving
Slack by hand.

**Success looks like:** `pnpm e2e:live` runs unattended, drives real Slack
traffic through the real bot on both runtimes, asserts deterministically, cleans
up after itself, exits non-zero on any regression, and writes a machine-readable
report an agent can read back.

---

## 1. Why this exists

The repository already documents this exact hole. `docs/plans/2026-08-23-openai-agents-sdk-support.md:15`:

> Live Slack and external MCP end-to-end verification remain deployment-environment gates.

And `docs/design/2026-08-23-slack-ai-agent-openai-agents-sdk-design.md:1500` (§24.5)
specifies integration smoke tests that were only ever half-built.

What exists today:

- `scripts/openai-smoke.ts` — calls the OpenAI Responses API directly. It never
  touches Slack, never boots the app, and has no Anthropic counterpart.
- 509 Jest unit tests that are **structurally incapable** of reaching the
  network: `src/test-support/offline-guard.ts` scrubs every provider credential
  and refuses outbound sockets and provider-CLI spawns.

So nothing verifies the parts that actually break in production: Socket Mode
delivery, `SlackHandler` event routing, session continuity across a thread,
reaction lifecycle, MCP and workspace tool execution, the approval-button path,
cancellation, and provider-error handling.

---

## 2. Workspace binding

These are live values for this deployment. The harness must read them from the
environment, never hard-code them.

| Thing           | Value                                                    | Env var to introduce         |
| --------------- | -------------------------------------------------------- | ---------------------------- |
| Slack workspace | `watervalley` / `T1LBJN3D2`                              | (from `SLACK_WORKSPACE_URL`) |
| Test channel    | `#slack-ai-agent-test` / `C0BRUSM9M4P`                   | `E2E_SLACK_CHANNEL_ID`       |
| Bot user        | `codepilot` / `U0BQUP1M6ER` (bot_id `B0BQYDJP0MQ`)       | `E2E_BOT_USER_ID`            |
| Slack App       | `A0BQS7CTWR1` (`https://api.slack.com/apps/A0BQS7CTWR1`) | —                            |
| Driver identity | `minoru` / `U1LBQTL8G`                                   | `E2E_DRIVER_USER_ID`         |

Credentials already present in `.env` (names only — never print values):

- `CC_SLACK_BOT_TOKEN` (`xoxb`) — bot. Used for reaction reads, `conversations.open`, bot-message cleanup.
- `CC_SLACK_APP_TOKEN` (`xapp`) — Socket Mode.
- `CC_SLACK_SIGNING_SECRET`.
- `SLACK_MCP_XOXP_TOKEN` (`xoxp`, user `U1LBQTL8G`) — **the driver**. Verified to hold `chat:write`, so it can post and delete its own messages. No user-scope change is required.
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.

Models for the matrix: `anthropic/claude-haiku-4-5` and `openai/gpt-5.6-luna`
(`DEFAULT_OPENAI_MODEL`, `src/runtimes/openai/model-config.ts:1`). Use the cheap
tier deliberately — this suite is meant to be run often.

---

## 3. Preconditions that are broken right now

Fix these **before** building, and verify each fix with the command given.
Both were confirmed by direct probe, not inference.

### 3.1 The installed bot is missing five declared scopes

`slack-app-manifest.yaml` declares them; the installed app does not have them.
Installed scopes are: `app_mentions:read, chat:write, im:write, reactions:write,
assistant:write, channels:history, groups:history, im:history, im:read,
reactions:read, users:read`. Missing: **`channels:read`, `groups:read`,
`groups:write`, `chat:write.public`, `files:read`**.

This is not cosmetic. `conversations.info` returns `missing_scope: channels:read`,
and `ChannelConfigManager.lookupChannelType` fails **closed** to `"im"`
(`src/channel-config.ts:288-295`). Consequence: every public-channel `app_mention`
is currently processed as though it were a DM — the conditional-reply branch in
`src/slack-handler.ts:2551-2559` is skipped and DM privacy redaction is applied
to a public channel. A naive E2E test would go green while exercising the wrong
branch entirely.

Fix at `https://api.slack.com/apps/A0BQS7CTWR1` → _OAuth & Permissions_ → add the
bot scopes → _Reinstall to Workspace_. Then verify:

```bash
set -a; . ./.env; set +a
curl -s -H "Authorization: Bearer $CC_SLACK_BOT_TOKEN" \
  "https://slack.com/api/conversations.info?channel=$E2E_SLACK_CHANNEL_ID" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("ok"), d.get("error"), (d.get("channel") or {}).get("name"))'
```

Required output: `True None slack-ai-agent-test`.

Note: reinstalling rotates `CC_SLACK_BOT_TOKEN`. Update `.env` afterwards and
re-run `auth.test`.

### 3.2 `.env` names an Anthropic model that does not exist

`.env` sets `AGENT_DEFAULT_MODEL=anthropic/claude-haiku-4.5`. `parseModelRef`
(`src/agent/model.ts:30-45`) only splits on `/` and never validates the model
name, so this passes configuration and fails at the API on every turn. Probed:

- `claude-haiku-4.5` → `{"type":"not_found_error"}`
- `claude-haiku-4-5` → resolves to `claude-haiku-4-5-20251001`

Correct it to `anthropic/claude-haiku-4-5`. Verify:

```bash
set -a; . ./.env; set +a
curl -s https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("model"))'
```

Required output: a concrete dated model id.

**Design note worth acting on:** that a typo in a model id can reach the provider
is a validation gap. Do not add a hard allowlist — model ids change faster than
this repo does. A cheap, honest gate is a startup log line naming the resolved
`ModelRef` for every enabled provider, so a bad id is visible in the first ten
lines of `pnpm start` instead of in a user's failed Slack thread.

---

## 4. Harness architecture

### 4.1 Why a child process per provider

`src/config.ts` evaluates `defaultProvider`, `defaultModel` and `SANDBOX_ROOT` as
**module-level constants at import time** (`src/config.ts:24, 152-158`). Two
provider phases therefore cannot share one process. The harness parent forks one
child per phase. This is not merely a workaround — it also proves the
single-provider startup path that
`docs/design/2026-08-23-slack-ai-agent-openai-agents-sdk-design.md` lists as an
exit criterion ("OpenAI-only startup works").

### 4.2 Why IPC, not HTTP

A Block Kit button click **cannot be originated through any Slack Web API**.
There is no endpoint for it. But Bolt 4.7.3 exposes

```
processEvent(event: ReceiverEvent): Promise<void>
```

as a **public** method (`node_modules/@slack/bolt/dist/App.d.ts:226` — note it
carries no `private` modifier, unlike `private receiver` on line 102). So the
parent sends the child an IPC command and the child injects the exact
`block_actions` payload Slack would have delivered, through the real Bolt
middleware chain into the real `app.action("approve_action")` handler
(`src/custom-actions/registry.ts:477`). The handler's side effects — `chat.update`,
`chat.postMessage` — hit real Slack and are asserted there.

Node IPC also avoids forging HMAC request signatures, and keeps the app in Socket
Mode so every other cycle uses genuine Slack delivery.

**State the boundary honestly in the report:** this cycle verifies our handler
chain and its Slack side effects. It does not verify Slack's delivery of the
click. Confirm _Interactivity_ is enabled once, by hand, at
`https://api.slack.com/apps/A0BQS7CTWR1` — the tracked manifest has
`interactivity.is_enabled: false`, which would break real users' clicks while
leaving this cycle green.

**Do not reimplement the button `value` encoding.** Read the confirmation
message back from Slack with `conversations.replies`, pull `action_id` and
`value` off the rendered block, and inject those verbatim. That keeps the cycle
correct even if `parseButtonValue` changes.

### 4.3 Layout

```
e2e/
  run.ts                    # parent: CLI, phase matrix, report, exit code
  agent-host.ts             # child: createApp() + start() + IPC injection listener
  lib/
    env.ts                  # load .env, validate, build per-phase env overlay
    slack-driver.ts         # xoxp Web API: post, poll replies, reactions, cleanup
    child.ts                # fork/readiness/teardown
    nonce.ts                # per-run + per-cycle marker derivation   [pure]
    payloads.ts             # block_actions payload builder            [pure]
    matchers.ts             # reply/reaction/log assertions            [pure]
    report.ts               # JSON + human summary                     [pure]
  cycles/*.ts               # one file per cycle, see §5
  fixtures/
    echo-mcp-server.ts      # stdio MCP server exposing e2e_echo
    e2e-echo-action.ts      # custom action with an approval button
    fake-provider-server.ts # local HTTP returning 500 / overloaded_error
```

`e2e/` is chosen deliberately: `.gitignore` swallows `scripts/*` except
`scripts/openai-smoke.ts`, and `jest.config.js` roots are `src` and `config`, so
a harness under `e2e/` is tracked by git and excluded from `pnpm test` without
any configuration surgery.

### 4.4 Readiness and teardown

Child readiness = the existing startup line `⚡️ Slack AI agent is running!`
(`src/index.ts`). Do not sleep on a timer. Teardown must kill the child, delete
every message the run created (driver messages with the user token, bot messages
with the bot token), remove fixture files, and restore any deployment config it
materialised.

---

## 5. Cycles

Run the full `{anthropic, openai} × cycles` matrix. Every cycle derives a nonce
`E2E-<runId>-<cycleId>` and instructs the bot to answer with an exact marker, so
no assertion depends on model phrasing.

| #   | Cycle               | Drive                                                                              | Assert                                                                                                 |
| --- | ------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | `channel-mention`   | user posts `<@$E2E_BOT_USER_ID> reply with exactly OK-<nonce>` in the test channel | threaded reply contains the nonce; child log shows `channelType=channel` (guards §3.1 from regressing) |
| 2   | `dm`                | bot `conversations.open({users})` to resolve the D-channel, user posts into it     | reply contains the nonce                                                                               |
| 3   | `thread-continuity` | msg 1 plants a token; msg 2 in the same thread asks for it back                    | msg 2's reply echoes msg 1's token                                                                     |
| 4   | `workspace-tool`    | fixture file written into `data/`, bot asked to read it                            | reply contains the file nonce **and** `workspace_read_file` appears in the tool log                    |
| 5   | `mcp-tool`          | `e2e_echo` on the fixture stdio MCP server                                         | reply contains `MCP-OK-<nonce>`                                                                        |
| 6   | `reactions`         | any turn                                                                           | `reactions.get` observes `thinking_face` then `white_check_mark`                                       |
| 7   | `button-approval`   | inject `block_actions` per §4.2                                                    | the action's side-effect message lands in the real thread                                              |
| 8   | `cancellation`      | two messages in rapid succession, same thread                                      | only the newer nonce is answered; abort visible in log                                                 |
| 9   | `provider-error`    | `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` pointed at the local fake server          | bot posts an error message and sets the `x` reaction                                                   |

Notes:

- Cycles 8 and 9 use a **local** fake provider, so they are deterministic and
  cost nothing. Prefer that shape for any future failure-path cycle.
- Reaction names come from `config/example-emojis.yaml` when no deployment
  `config/emojis.yaml` exists (`src/reaction-manager.ts:27-39`). Read them from
  the same loader rather than hard-coding emoji names.
- The bot threads replies under `event.thread_ts || event.ts`, and the session
  key is `(userId, channelId, threadTs)`
  (`src/sessions/session-manager.ts:37`). So poll `conversations.replies` on the
  driver message's own `ts`, and drive cycle 3 by setting `thread_ts` to it.
- Model fallback (`OpusHealthMonitor`) is reachable by having the fake provider
  return an `overloaded_error`. If the fallback path turns out to need internals
  the harness cannot reach from outside, **record it as a documented gap in the
  report rather than weakening the assertion**.
- Check whether the OpenAI MCP adapter (`src/runtimes/openai/mcp-adapter.ts`)
  actually supports stdio servers on the installed `@openai/agents` version
  before assuming cycle 5 is symmetric across providers. If it is not, report it
  as a gap; do not fake it.

---

## 6. Required `src` seams

Three changes. Each is a testability seam that stands on its own merit — none is
a test-only code path.

1. **Extract `src/app.ts` exporting `createApp()`; reduce `src/index.ts` to the
   CLI entry.** All wiring is currently trapped inside a ~130-line `start()`, so
   nothing but the CLI can boot the app. `agent-host.ts` needs an importable
   factory.
2. **`new McpManager(process.env.MCP_CONFIG_PATH ?? "./mcp-servers.json")`.** The
   constructor already accepts a path (`src/mcp-manager.ts:137`); `index.ts` just
   never passes one. Without this the harness must clobber the developer's real
   `mcp-servers.json`.
3. **`CUSTOM_ACTIONS_DIR` override in `src/custom-actions/loader.ts`.** The
   loader hard-skips `example-*` files, and `.gitignore` permits _only_
   `example-*` in `config/custom-actions/`. There is otherwise no way to land a
   fixture action without gitignore surgery or overwriting deployment config.

Keep each behind existing defaults so production behaviour is unchanged.

---

## 7. Testing discipline

The harness is code, and it must not rot silently.

- Pure modules (`nonce`, `payloads`, `matchers`, `report`) are written
  test-first: failing test, minimum implementation, then generalise. Mutation-check
  each new test — disable the behaviour it guards, watch **that** test fail,
  revert. A test that passes either way is not coverage.
- Add `<rootDir>/e2e` to `jest.config.js` `roots` so `e2e/**/*.test.ts` runs in
  normal CI. `testMatch` is `**/*.test.ts`, so the live cycle files are not
  picked up. This is what stops the harness from decaying between live runs.
- The three §6 seams get unit tests for the override behaviour and its default.
- Live cycles never run under Jest — `src/test-support/offline-guard.ts` would
  block them, and correctly so.

---

## 8. Safety rails

Non-negotiable:

- Refuse to run unless `E2E_LIVE=1`.
- Refuse any channel other than `E2E_SLACK_CHANNEL_ID`, and refuse if its name
  does not contain `test`.
- Never print a token, an Authorization header, or raw provider payloads. Follow
  the existing precedent in `scripts/openai-smoke.ts`, which logs `error.name`
  only.
- Delete every message the run created, on success **and** on failure. A failed
  run must not leave the channel dirty.
- Back up and restore — or refuse to overwrite — any deployment config the run
  materialises.
- Bound the run: a hard cycle cap and a per-cycle timeout, so a hung turn cannot
  spend money indefinitely.

---

## 9. Definition of Done

Machine-checkable:

```bash
pnpm test                 # 509+ existing tests plus new e2e/ unit tests, all green
npx tsc --noEmit          # clean
E2E_LIVE=1 pnpm e2e:live  # exit 0, full matrix green
```

Plus:

- `e2e/report/<runId>.json` exists and records per-cycle status, provider,
  duration, and any documented gap.
- `git status` is clean after a run — no leftover fixtures, no modified
  deployment config.
- The test channel contains no residue from the run.
- Both §3 preconditions verify with the commands given in that section.
- `README.md` gains a short section on running the live suite and what it costs.

---

## 10. Out of scope

- File-upload cycles. They need `files:read` on the bot and `files:write` on the
  driver token; the driver token has neither. Add later with the scopes.
- Real browser-driven Slack UI interaction. The only thing needing it is
  verifying Slack's own delivery of a button click; that stays a one-time manual
  check (§4.2).
- Running this in shared CI. It needs live credentials and spends provider money.
  It is a local and pre-release gate.
