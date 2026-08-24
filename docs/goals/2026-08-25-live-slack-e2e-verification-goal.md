# Goal: Automated Live-Slack End-to-End Verification for Both Runtimes

> **For agentic workers:** This document is the complete brief. Everything you
> need — workspace identifiers, credential names, the seams the harness relies
> on, its known limits, and the acceptance gate — is stated here or reachable
> from a path named here. Do not ask the human for missing context; probe the
> repository and the live APIs instead.
>
> REQUIRED SUB-SKILLS: `superpowers:test-driven-development` for every pure
> module you add, and `superpowers:verification-before-completion` before
> claiming any part of this done.

**Goal:** Give this repository an automated end-to-end verification cycle that
exercises the real Slack agent, in a real Slack workspace, against both the
Anthropic and the OpenAI runtime — so a coding agent changing this codebase can
prove its change works in production conditions without a human driving Slack
by hand.

**Success looks like:** `pnpm e2e:live` runs unattended, drives real Slack
traffic through the real bot on both runtimes, asserts deterministically, cleans
up after itself, exits non-zero on any regression, and writes a
machine-readable report an agent can read back.

---

## 1. Why this exists

The repository already documents the hole.
`docs/plans/2026-08-23-openai-agents-sdk-support.md:15`:

> Live Slack and external MCP end-to-end verification remain deployment-environment gates.

And §24.5 of `docs/design/2026-08-23-slack-ai-agent-openai-agents-sdk-design.md`
specifies integration smoke tests that were only ever half-built.

Before this work, the only live check was `scripts/openai-smoke.ts`, which calls
the OpenAI Responses API directly and never touches Slack. The 500-odd Jest
tests are structurally incapable of reaching the network:
`src/test-support/offline-guard.ts` scrubs provider credentials and refuses
outbound sockets. Nothing exercised Socket Mode delivery, `SlackHandler` event
routing, session continuity, the reaction lifecycle, workspace or MCP tool
execution, the approval-button path, cancellation, or provider-error handling.

**This was not theoretical.** The harness found two defects on its first live
run, both of which left a fresh checkout unable to answer at all, and both
invisible to the existing tests. They are described in §7.

---

## 2. Workspace binding

Live values for this deployment. The harness reads them from the environment or
derives them; nothing is hard-coded in `src/` or `e2e/`.

| Thing           | Value                                  | How the harness gets it                    |
| --------------- | -------------------------------------- | ------------------------------------------ |
| Slack workspace | `watervalley` / `T1LBJN3D2`            | `auth.test`                                |
| Test channel    | `#slack-ai-agent-test` / `C0BRUSM9M4P` | `--channel` flag or `E2E_SLACK_CHANNEL_ID` |
| Bot user        | `codepilot` / `U0BQUP1M6ER`            | `auth.test` with the bot token             |
| Slack App       | `A0BQS7CTWR1`                          | —                                          |
| Driver identity | `minoru` / `U1LBQTL8G`                 | `auth.test` with the user token            |

Only the channel needs configuring. Credentials already in `.env` (names only —
never print values):

- `CC_SLACK_BOT_TOKEN` (`xoxb`) — reaction reads, `conversations.open`, bot-message cleanup.
- `CC_SLACK_APP_TOKEN` (`xapp`) — Socket Mode.
- `CC_SLACK_SIGNING_SECRET`.
- `SLACK_MCP_XOXP_TOKEN` (`xoxp`) — **the driver**. Holds `chat:write`, so it can post and delete its own messages.
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.

Phase models are pinned in `e2e/lib/phase-env.ts` to `anthropic/claude-haiku-4-5`
and `openai/gpt-5.6-luna` — the cheap tier, deliberately, because this suite is
meant to be run often.

---

## 3. Preconditions

Both of these were broken when this work started and have been fixed. Verify
them before blaming the harness.

### 3.1 Bot scopes

The installed app must hold `channels:read`, `groups:read`, `groups:write`,
`chat:write.public` and `files:read` in addition to its original eleven. They
were missing, so `conversations.info` returned `missing_scope` and
`ChannelConfigManager.lookupChannelType` failed **closed** to `"im"`
(`src/channel-config.ts:288-295`) — every public-channel `app_mention` was
processed as a DM, skipping the conditional-reply branch and applying DM privacy
redaction. The reply still arrived, so only a log assertion catches it.

Add scopes at `https://api.slack.com/apps/A0BQS7CTWR1` → _OAuth & Permissions_ →
_Reinstall to Workspace_. Verify:

```bash
set -a; . ./.env; set +a
curl -s -H "Authorization: Bearer $CC_SLACK_BOT_TOKEN" \
  "https://slack.com/api/conversations.info?channel=C0BRUSM9M4P" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("ok"), d.get("error"), (d.get("channel") or {}).get("name"))'
```

Required: `True None slack-ai-agent-test`. Reinstalling did **not** rotate the
bot token in this workspace, but check `auth.test` afterwards rather than
assuming.

The `channel-mention` cycle guards this permanently by asserting the app never
logged `Failed to look up channel type`.

### 3.2 Model identifier

`.env` named `anthropic/claude-haiku-4.5`, which does not exist. `parseModelRef`
(`src/agent/model.ts:30-45`) only splits on `/` and never validates the name, so
it passed configuration and failed at the API on every turn. The canonical id
uses hyphens (`claude-haiku-4-5`, resolving to `claude-haiku-4-5-20251001`).

**Still open, and worth doing:** nothing surfaces a bad model id until a user's
turn fails. Do not add a hard allowlist — model ids change faster than this repo
does. Log the resolved `ModelRef` for every enabled provider at startup, so a
typo is visible in the first ten lines of `pnpm start`.

---

## 4. Harness architecture

### 4.1 A child process per provider

`src/config.ts` evaluates `defaultProvider`, `defaultModel` and `SANDBOX_ROOT` as
module-level constants at import time (`src/config.ts:24, 152-158`), so two
provider phases cannot share a process. The parent forks one child per phase
(`e2e/agent-host.ts`), which also proves the single-provider startup path listed
as an exit criterion in the OpenAI design doc.

**The dotenv trap.** The child imports `src/config.ts`, which calls
`dotenv.config()`, and dotenv fills in any variable _absent_ from the
environment. Deleting the other provider's API key therefore hands it straight
back from `.env`, silently re-enabling the provider the phase excludes.
`phaseEnv` blanks those variables instead: an empty string is present as far as
dotenv is concerned and falsy everywhere the application tests it. The host
reports the providers it actually enabled and the runner asserts on that, so
this is verified rather than assumed.

### 4.2 IPC, and the button click

A Block Kit click **cannot be originated through any Slack Web API**. Bolt 4.7.3
exposes `processEvent(event: ReceiverEvent)` publicly
(`node_modules/@slack/bolt/dist/App.d.ts:226`), so the parent sends the child an
IPC command and the child injects the exact `block_actions` payload Slack would
have delivered, into the real middleware chain and the real
`app.action("approve_action")` handler (`src/custom-actions/registry.ts:477`).
Its side effects hit real Slack and are asserted there.

The payload's `action_id` and `value` are read back off the live confirmation
message rather than reconstructed, so the harness never duplicates
`parseButtonValue`'s encoding and cannot drift from it.

**Boundary, stated plainly:** this verifies our handler chain and its Slack side
effects. It does not verify Slack's delivery of the click. Confirm
_Interactivity_ is enabled once by hand at the app settings page — the tracked
manifest has `interactivity.is_enabled: false`, which would break real users'
clicks while leaving this cycle green.

### 4.3 Constructing Bolt is not free of I/O

Worth knowing before writing tests against `createApp`: with the default
`tokenVerificationEnabled: true`, Bolt's `singleAuthorization`
(`node_modules/@slack/bolt/dist/App.js:828-831`) fires `auth.test`
**immediately** and leaves the promise floating, so an invalid token surfaces as
an unhandled rejection that kills the process after the suite finishes, not as a
thrown error. Unit tests rely on `src/test-support/offline-guard.ts` to refuse
the socket.

### 4.4 Host profiles, and why cycles must not share one

Cycles are grouped into three host profiles, and each group gets its own child
process per provider:

- `default` — fixture MCP server and workspace file
- `actions` — as `default`, plus the approval-gated fixture action
- `failing-provider` — provider base URL pointed at a local failing endpoint

This is not tidiness. The fixture action is registered with `alwaysInject`, so
on a host that loads it every turn is offered a "record a verification code"
tool. The model will sometimes call it during an unrelated cycle: a full matrix
run had `mcp-tool` fail because the agent called the approval action first,
which posted a confirmation dialog and derailed the turn. That failure was
non-deterministic — the same cycle had passed twice before — and a flaky
verification suite is worse than none, because it teaches its readers to ignore
red. Isolating by profile removes the interference structurally rather than
hoping the model behaves.

### 4.5 Layout

```
e2e/
  run.ts                    parent: CLI, phase matrix, report, exit code
  agent-host.ts             child: createApp + start + IPC injection
  lib/
    config.ts               flags, preflight, guardrails
    markers.ts              per-run/per-cycle markers, boundary-safe matching
    slack.ts                Slack Web API client, polling
    host.ts                 fork, readiness, log capture, teardown
    phase-env.ts            per-phase environment overlay
    block-actions.ts        button discovery and payload assembly
    cycle.ts                cycle context, assertions, cleanup
    deployment-config.ts    materialise/restore config files
    fixtures.ts             fixture allowlist, MCP config, workspace file
    report.ts               summarisation and exit code
  cycles/*.ts               one file per cycle
  fixtures/
    echo-mcp-server.mjs     stdio MCP server exposing e2e_echo
    fake-provider-server.ts local endpoint that fails every request
    actions/e2e-approval.ts approval-gated custom action
```

`e2e/` is chosen deliberately: `.gitignore` swallows `scripts/*` except
`scripts/openai-smoke.ts`, and `jest.config.js` roots were `src` and `config`.
Adding `<rootDir>/e2e` to those roots runs `e2e/**/*.test.ts` in normal CI while
`testMatch` leaves the live cycle modules alone.

---

## 5. Cycles

The matrix is `{anthropic, openai} × 9 cycles`. Every cycle derives a marker
`E2E-<runId>-<cycleId>`, so no assertion depends on model phrasing and a reply
left over from an earlier run cannot satisfy a later one.

| #   | Cycle               | Asserts                                                                                                                                |
| --- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `channel-mention`   | threaded reply carries the marker; the app never logged `Failed to look up channel type` (guards §3.1)                                 |
| 2   | `dm`                | reply carries the marker in an IM channel opened with the bot token (the driver holds `chat:write` but not `im:write`)                 |
| 3   | `thread-continuity` | a follow-up in the same thread echoes a reference code only available from the first turn                                              |
| 4   | `reactions`         | the terminal reaction appears; the in-progress one is reported as evidence, not asserted, because a fast turn can finish between polls |
| 5   | `workspace-tool`    | the reply contains a file's contents _and_ the app recorded a non-zero tool-call count                                                 |
| 6   | `mcp-tool`          | the reply contains the fixture MCP server's `MCP-OK-<code>`, a format absent from the prompt                                           |
| 7   | `button-approval`   | the approval dialog is posted, the injected click runs the action, and its effect lands in the thread                                  |
| 8   | `cancellation`      | a burst yields exactly one reply, and the first turn was superseded or abandoned                                                       |
| 9   | `provider-error`    | a failing provider is reported to the user; the fake endpoint is confirmed to have been called first                                   |

Notes worth keeping:

- **Cancellation asserts the real contract.** An earlier version asserted the
  reply carried the _second_ message's marker and failed against correct
  behaviour: coalescing folds both messages into one query, so which instruction
  the model follows is its choice, not a product guarantee.
- **The failure endpoint returns 401, not 500.** Both SDKs retry a 500 with
  backoff, which kept the turn in flight past any sane timeout with the user
  seeing nothing. An auth failure is terminal.
- **Wording matters.** Asking the bot to remember a "token" or "secret" makes
  the model refuse on security grounds — correct behaviour worth keeping, so the
  cycle asks about a neutral reference code instead.

---

## 6. Seams this depends on

Four changes, each standing on its own merit rather than existing only for tests:

1. **`src/app.ts` exporting `createApp()`**, with `src/index.ts` reduced to the
   CLI entry. All wiring was trapped inside a ~130-line `start()`.
2. **`MCP_CONFIG_PATH`** honoured by `McpManager`'s constructor default, so a
   harness need not clobber the deployment's `mcp-servers.json`.
3. **`CUSTOM_ACTIONS_DIR`** honoured by `src/custom-actions/loader.ts`. The
   loader hard-skips `example-*`, and `.gitignore` permits only `example-*` in
   `config/custom-actions/`, so there was otherwise no way to land a fixture
   action.
4. **`src/slack-bolt.d.ts` extended** with `stop` and `processEvent`. That file
   is a deliberately minimal stub that shadows Bolt's real types and says
   "Extend as needed".

`config/tool-allowlist.yaml` has no environment override, so the harness writes
it into `config/` and restores it on teardown, capturing any original first.

---

## 7. Defects this found

Both were found on the first live run, and neither was reachable from the unit
tests. Fixed, with tests that fail without the fix.

**Null config maps.** `config/example-channels.yaml` ships
`ephemeralChannelConfig` and `dmNotificationConfig` with every entry commented
out, so js-yaml parses them as `null`. `shouldUseEphemeralMessaging` evaluated
`channelId in null` and threw — and the error handler re-entered the same path,
so the turn died with no reply at all. The existing tests mocked those keys as
`{}` and could not see it. Now normalised at the load boundary, and guarded by a
test that reads the shipped example file rather than a fixture.

**Missing tool allowlist.** `config/tool-allowlist.yaml` had no example fallback,
unlike its siblings, so a missing file threw ENOENT inside the Claude streaming
path; it retried three times and answered "Something went wrong". It now fails
closed with a warning. Deliberately _no_ fallback to the example file: an
allowlist grants permissions, so adopting the template's grants because nobody
wrote one would hand out tools no operator chose.

---

## 8. Known limits

State these in any report; they bound what a green run means.

- **The driver is app-attributed.** `SLACK_MCP_XOXP_TOKEN` is a user token
  belonging to this same Slack app, so Slack stamps `bot_id` and `app_id` on
  everything it posts, and `as_user` does not change that. `SlackHandler`
  therefore treats driver messages as bot messages and ignores them unless the
  bot is explicitly mentioned. Consequences:
  - Every driver message @-mentions the bot. This is applied in `say()` rather
    than per cycle, so a new cycle cannot forget it and misread the resulting
    silence as a product bug.
  - The role resolves through `getHighestRole()` rather than
    `UserUtils.getUserRole`, so the fixture allowlist uses a single role.
  - **Not covered:** the plain-human-message paths — conditional-reply channels
    and proactive smart reply. A second Slack app would not help; the
    attribution is inherent to granular-scope apps.
- **Button delivery is not covered** (§4.2).
- **A failing provider is slow to surface.** Measured at roughly 200 seconds
  against a failing Anthropic endpoint before the user is told anything. The
  cycle passes because the error does eventually arrive, but a turn timeout
  would be a real improvement.
- **File-upload cycles are absent.** They need `files:read` on the bot (now
  present) and `files:write` on the driver token (still absent).

---

## 9. Testing discipline

- Pure modules (`markers`, `block-actions`, `report`, `phase-env`, `config`
  flags, `deployment-config`, `slack` predicates) are written test-first and
  mutation-checked: disable the behaviour the test guards, watch **that** test
  fail, revert. One test here passed with its behaviour removed and had to be
  rewritten — an unmutated test is a green light with no bulb in it.
- `<rootDir>/e2e` is in `jest.config.js` roots so harness logic runs in normal
  CI. Live cycle files are not `*.test.ts` and are never picked up.
- Live cycles never run under Jest; the offline guard would block them, correctly.

---

## 10. Safety rails

- Refuses to run unless `E2E_LIVE=1`.
- Refuses any channel whose name does not contain `test`, or that the bot is not
  a member of.
- Never prints a token, an Authorization header, or a raw provider payload.
- Deletes every message it created, on success and on failure, and on SIGINT.
  `chat.delete` is rate-limited and teardown deletes in a burst, so the client
  honours `Retry-After`; anything it still cannot remove is printed as
  `LEFT BEHIND`, because a run that leaves messages in the channel has not
  finished even if every cycle passed.
- Captures and restores any deployment config it writes.
- Bounded per-cycle timeouts; only `provider-error` raises its own, and says why.

---

## 11. Definition of Done

```bash
pnpm test                                  # unit suite, including e2e/ pure logic
pnpm typecheck                             # tsc -p tsconfig.test.json --noEmit
E2E_LIVE=1 pnpm e2e:live --channel C0BRUSM9M4P
```

The live run must exit 0 with the full matrix green. Plus:

- `e2e/report/<runId>.json` records per-cycle status, provider, duration and
  evidence; `e2e/report/<runId>-<phase>.log` holds the app's own output.
- `git status` is clean after a run — no leftover fixtures, no modified
  deployment config.
- The test channel contains no residue.
- Both §3 preconditions verify with the commands given there.

---

## 12. Runbook

```bash
E2E_LIVE=1 pnpm e2e:live --channel C0BRUSM9M4P                 # full matrix
E2E_LIVE=1 pnpm e2e:live --channel C… --provider openai        # one runtime
E2E_LIVE=1 pnpm e2e:live --channel C… --cycle mcp-tool         # one cycle
E2E_LIVE=1 pnpm e2e:live --channel C… --keep                   # leave messages for inspection
```

A failing cycle prints the app's own ERROR/WARN lines beneath it. The full phase
log is in `e2e/report/`.

---

## 13. Out of scope

- Running this in shared CI. It needs live credentials and spends provider
  money; it is a local and pre-release gate.
- Real browser-driven Slack UI interaction.
- File uploads, until the driver token gains `files:write`.
