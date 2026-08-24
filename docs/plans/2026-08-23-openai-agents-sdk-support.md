# OpenAI Agents SDK Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add production-quality OpenAI Agents SDK support to the Slack agent while preserving its existing Anthropic runtime and Slack behavior.

**Architecture:** Introduce provider-neutral sessions, model references, events, permissions, and runtime contracts between Slack-facing code and provider SDKs. Adapt the current Claude implementation first, then add a standard OpenAI `Agent`/`Runner` implementation with safe workspace tools, request-scoped MCP, existing Slack approvals, and provider-neutral telemetry. Keep the optional beta `SandboxAgent` outside this delivery.

**Tech Stack:** TypeScript 6, Node.js 22+, pnpm, Jest/ts-jest, `@openai/agents`, Claude Agent SDK, Slack Bolt, MCP SDK, Zod 4.

**Spec:** `docs/design/slack-ai-agent-openai-agents-sdk-design.md`

**Execution result (2026-08-23):** Implemented Tasks 1-9. Parent acceptance
covered the full Jest/build/frozen-lockfile gates, mutation checks for the
review fixes, and the live OpenAI text/function-tool smoke. Live Slack and
external MCP end-to-end verification remain deployment-environment gates.

## Global Constraints

- Preserve Anthropic as the default and accept existing unqualified Claude model and legacy tool configuration.
- Support Anthropic-only, OpenAI-only, and mixed deployments; require credentials only for enabled providers.
- Use the OpenAI Responses-backed standard `Agent`/`Runner` path. Do not add `SandboxAgent` or arbitrary shell access.
- Provider SDK event types may exist only inside provider runtime adapters.
- Deny wins, unknown roles/tools are denied, identity-bound MCP fails closed, and subagents cannot broaden parent permissions.
- Keep OpenAI tracing disabled unless explicitly enabled. Never log keys, authorization headers, raw private prompts, or provider state.
- Use pnpm exclusively and confirm exact APIs against the installed `@openai/agents` version.
- Follow strict Red -> Green -> Refactor. For every new behavior, demonstrate that the focused test fails before implementation and mutation-check the new test before considering it complete.
- Do not alter or expose `.env`; optional live checks load it through dotenv and use `gpt-5.6-luna`.
- Do not add checksum/integrity machinery beyond pnpm's existing lockfile.

## Definition of Done

- `CI=true pnpm install --frozen-lockfile` succeeds.
- `pnpm test --runInBand` passes all unit and contract tests.
- `pnpm run build` succeeds.
- Architecture assertions from spec section 25 pass: Slack code has no concrete Claude dependency, message processing has no provider SDK event imports, and sessions/workspaces are provider-neutral.
- OpenAI-only startup is covered without `ANTHROPIC_API_KEY`; unit tests cover stream normalization, continuation, cancellation, max turns, custom base URL, and tracing-off defaults.
- Security tests cover deny precedence, unknown roles/tools, identity omission, subagent intersection, traversal, absolute escape, symlink escape, bounded output, and binary handling.
- Existing Slack approval/custom-action UX and Claude regression tests pass.
- Optional live OpenAI smoke produces one text response and one deterministic function-tool call with `gpt-5.6-luna`; if provider access prevents it, report that gate separately without weakening local acceptance.
- README, `.env.example`, and example YAML describe provider selection, models, tools, migration, and pnpm commands.

---

### Task 1: Restore the test harness and extract provider-neutral sessions

**Files:**

- Create: `tsconfig.test.json`
- Create: `src/sessions/session-manager.ts`
- Create: `src/sessions/session-manager.test.ts`
- Modify: `src/types.ts`, `src/config.ts`, `src/claude-handler.ts`, `src/claude-handler.test.ts`, `src/slack-handler.ts`, `src/slack-handler.test.ts`

**Interfaces:**

- Produces `ConversationSession.providerState: Partial<Record<AgentProviderId, ProviderSessionState>>`.
- Produces `SessionManager.getSessionKey/getSession/createSession/cleanupInactiveSessions`.

- [ ] Write a failing session-manager test proving stable keying, provider-neutral workspace provisioning, provider-specific state separation, and cleanup.
- [ ] Add `tsconfig.test.json` extending `tsconfig.json` with `types: ["jest", "node"]`, `noEmit: true`, and test-inclusive globs; run `pnpm test --runInBand` and record the now-visible baseline.
- [ ] Move session ownership out of `ClaudeHandler`; inject `SessionManager` into Slack orchestration and keep Claude behavior unchanged.
- [ ] Mutation-check one session lifecycle assertion, restore it, then run session, Claude, Slack tests and `pnpm run build`.

### Task 2: Add runtime contracts and adapt Claude events

**Files:**

- Create: `src/agent/events.ts`, `src/agent/runtime.ts`, `src/agent/model.ts`, `src/agent/errors.ts`
- Create: `src/runtimes/registry.ts`, `src/runtimes/anthropic/runtime.ts`, `src/runtimes/anthropic/event-adapter.ts`
- Create: matching `*.test.ts` files
- Modify: `src/message-processor.ts`, `src/slack-handler.ts`, `src/claude-handler.ts`, affected tests

**Interfaces:**

- `AgentRuntime.stream(request: AgentRunRequest): AsyncIterable<AgentEvent>`.
- `AgentEvent` is the discriminated union from spec section 7.5 and emits exactly one terminal outcome.
- `AgentRuntimeRegistry.get(provider)` fails clearly for disabled runtimes.

- [ ] Write failing adapter and contract tests for text deltas, tool calls/results, usage, session update, cancellation, limits, failure, and exactly-one terminal event.
- [ ] Implement the types/registry and a Claude adapter that alone understands `SDKMessage`.
- [ ] Change `MessageProcessor.processClaudeStream` to provider-neutral `processAgentStream`; remove provider parsing and consume only `AgentEvent`.
- [ ] Route Slack execution through the registry, mutation-check terminal handling, then run all tests and build.

### Task 3: Generalize models, request modes, and provider-aware startup

**Files:**

- Modify: `src/agent/model.ts`, `src/config.ts`, `src/config.test.ts`, `src/request-mode.ts`, `src/request-mode.test.ts`, `src/channel-config.ts`, `src/channel-config.test.ts`, `src/index.ts`
- Create: `src/runtimes/anthropic/model-capabilities.ts`, `src/runtimes/openai/model-capabilities.ts`

**Interfaces:**

- `ModelRef { provider: "anthropic" | "openai"; model: string }` and `parseModelRef` preserve legacy Claude aliases.
- `config.agent.defaultProvider/defaultModel`, optional provider configs, and `validateEnabledProviders()`.

- [ ] Write failing table tests for qualified/unqualified models, effort/fast capabilities, OpenAI-only startup, mixed configuration, missing enabled credentials, and invalid provider/model combinations.
- [ ] Implement explicit capability registries and remove shared substring inference.
- [ ] Make credential validation provider-aware without reading or exporting key values.
- [ ] Mutation-check OpenAI-only validation, then run config/request/channel suites, all tests, and build.

### Task 4: Canonicalize MCP definitions and tool authorization

**Files:**

- Create: `src/mcp/types.ts`, `src/mcp/resolver.ts`, `src/mcp/permissions.ts`
- Create: `src/runtimes/anthropic/mcp-adapter.ts`
- Create: matching test files
- Modify: `src/mcp-manager.ts`, `src/mcp-manager.test.ts`, allow/deny examples, Claude runtime

**Interfaces:**

- `ToolIdentity`, `McpServerDefinition`, `ResolvedMcpServerDefinition`, `resolveMcpServers`, `computeEffectiveToolPolicy` match spec sections 11-12.
- Legacy `mcp__server__tool`, `Read`, `Grep`, `Glob`, and `Bash(...)` translation remains supported; Bash never maps to OpenAI shell.

- [ ] Write failing tests for transport normalization, trusted email binding, missing-identity omission, deny precedence, unknown role/tool denial, and legacy translation.
- [ ] Implement canonical loading/resolution/authorization; adapt canonical definitions back to current Claude SDK inputs.
- [ ] Mutation-check deny precedence and identity omission, then run MCP/Claude tests, all tests, and build.

### Task 5: Extract provider-neutral custom actions and subagents

**Files:**

- Create: `src/custom-actions/tool-definitions.ts`, `src/subagents/types.ts`, `src/subagents/loader.ts`
- Create: `src/runtimes/anthropic/action-adapter.ts`, `src/runtimes/anthropic/subagent-adapter.ts`
- Modify: `src/custom-actions/registry.ts`, `src/custom-actions/types.ts`, `src/validation-agent.ts`, affected tests

**Interfaces:**

- `ActionToolDefinition` and structured `ActionToolResult` carry `suppressReply` and `confirmationDialogPosted`.
- `SubagentDefinition` uses provider-neutral instructions/model/tools/maxTurns; effective tools are parent intersection requested.

- [ ] Write failing tests for action definition/invocation, structured suppression, legacy subagent YAML, model aliases, and permission intersection.
- [ ] Remove Anthropic construction from shared registries/loaders and implement Claude adapters preserving current UX.
- [ ] Mutation-check permission intersection and structured suppression, then run action/subagent/Claude tests, all tests, and build.

### Task 6: Implement the OpenAI text runtime

**Files:**

- Modify: `package.json`, `pnpm-lock.yaml`
- Create: `src/runtimes/openai/provider.ts`, `src/runtimes/openai/runtime.ts`, `src/runtimes/openai/event-adapter.ts`
- Create: matching unit tests and captured/synthetic fixtures
- Modify: `src/runtimes/registry.ts`, `src/index.ts`, telemetry types/call sites

**Interfaces:**

- A reusable OpenAI provider/Runner is configured from `OPENAI_API_KEY`, optional `OPENAI_BASE_URL`, store/session/tracing settings.
- Runtime maps streaming text, usage, `previousResponseId`, cancellation, and max-turn outcomes into `AgentEvent` and awaits stream settlement with bounded cleanup.

- [ ] Add `@openai/agents` using pnpm and inspect installed exports/types before coding.
- [ ] Write failing SDK-boundary tests for constructor options, Responses default, model reasoning mapping, tracing disabled by default, custom base URL, event normalization, cleanup, cancellation, limits, continuation, and usage.
- [ ] Implement minimal text-only OpenAI runtime and register only when enabled.
- [ ] Mutation-check continuation and terminal normalization, then run OpenAI/runtime tests, all tests, and build.

### Task 7: Add OpenAI MCP and custom-action tools with safe retries

**Files:**

- Create: `src/runtimes/openai/mcp-adapter.ts`, `src/runtimes/openai/action-adapter.ts`, matching tests
- Modify: OpenAI runtime, shared error/retry policy, runtime contract tests

**Interfaces:**

- stdio and Streamable HTTP map to current SDK MCP classes; unsupported legacy SSE fails with a configuration error.
- SDK `toolFilter` enforces canonical policy. Request-scoped MCP objects close after runs.
- Full-run retries stop after any side-effecting tool call.

- [ ] Write failing tests for class selection, filter enforcement, cleanup, action suppression, transient pre-tool retry, and no retry after a side effect.
- [ ] Implement MCP/action adapters and bounded retry classification without stacked large retry loops.
- [ ] Mutation-check filter denial and side-effect retry stop, then run MCP/action/runtime contracts, all tests, and build.

### Task 8: Add safe workspace tools and provider-neutral smart reply

**Files:**

- Create: `src/workspace/manager.ts`, `src/workspace/path-policy.ts`, `src/workspace/tools.ts`, matching tests
- Create: `src/agent/text-classifier.ts`
- Modify: `src/config.ts`, `src/file-handler.ts`, `src/smart-reply-filter.ts`, affected tests and OpenAI tool construction

**Interfaces:**

- Read/list/search tools operate only under the current real workspace root with bounded input/output.
- `TextClassifier.classify(input, { model, signal })` supports Anthropic or OpenAI without tools/session continuation.

- [ ] Write failing tests for valid nested reads, `..`, absolute and symlink escapes, cross-session access, size/search limits, binary files, provider-neutral prompt wording, timeout/error fail-closed, and OpenAI classifier selection.
- [ ] Implement the safe tools without shell/write support; inject only authorized workspace tools.
- [ ] Refactor smart reply to the provider-neutral classifier with cheap provider default and `SMART_REPLY_MODEL` override.
- [ ] Mutation-check symlink rejection and classifier fail-closed, then run workspace/file/classifier tests, all tests, and build.

### Task 9: Add OpenAI subagents, migration docs, and live smoke gates

**Files:**

- Create: `src/runtimes/openai/subagent-adapter.ts`, matching tests
- Create: `scripts/openai-smoke.ts`
- Modify: `README.md`, `.env.example`, `config/example-channels.yaml`, tool allow/deny examples, `package.json`

**Interfaces:**

- OpenAI subagents are manager-style agents-as-tools and cannot exceed parent policy.
- Smoke script supports text-only and deterministic function-tool modes, emits no secrets, and is excluded from normal CI.

- [ ] Write failing tests for OpenAI agents-as-tools construction, model resolution, and parent-policy intersection.
- [ ] Implement the adapter and mutation-check the non-escalation assertion.
- [ ] Document pnpm setup, three deployment modes, qualified models, canonical tools, deprecations, privacy/storage/tracing choices, and optional smoke commands.
- [ ] Run `pnpm test --runInBand` and `pnpm run build`.
- [ ] With `.env` loaded safely, run the optional smoke with `gpt-5.6-luna` for one text answer and one deterministic function call; record IDs only in restricted debug output and report any provider-access blocker separately.
- [ ] Inspect `git diff --check`, `git status --short`, and the complete diff for secrets, unexpected files, duplicated proof, or out-of-scope complexity.
