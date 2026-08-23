# Slack AI Agent

A provider-neutral Slack agent with Anthropic Claude Agent SDK and OpenAI Agents SDK runtimes. It responds in DMs, channels, and @-mentions with streaming responses, thread context, bounded workspace file tools, and extensible MCP integrations.

## Architecture

- **`src/slack-handler.ts`** - Message routing and event handling
- **`src/sessions/session-manager.ts`** - Provider-neutral conversation/workspace lifecycle
- **`src/runtimes/anthropic/`** - Claude Agent SDK runtime and adapters
- **`src/runtimes/openai/`** - OpenAI Agents SDK runtime and adapters
- **`src/mcp-manager.ts`** - MCP server configuration and tool management
- **`src/message-processor.ts`** - Stream processing and response formatting
- **`src/tracking.ts`** - Analytics tracking for message processing and feedback
- **`src/channel-config.ts`** - Channel-specific context and configuration management
- **`src/user-utils.ts`** - User information and role-based access control

## Setup

### 1. Install

Node.js 22 or newer and pnpm are required.

```bash
git clone https://github.com/mmizutani/slack-ai-agent.git
pnpm install
```

### 2. Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → "Create New App" → "From an app manifest"
2. Paste the contents of `slack-app-manifest.yaml`
3. Install the app to your workspace
4. Copy the **Bot User OAuth Token** (`xoxb-...`) from "OAuth & Permissions"
5. Generate an **App-Level Token** with `connections:write` scope (`xapp-...`) from "Basic Information"
6. Copy the **Signing Secret** from "Basic Information"

### 3. Configure Environment

```bash
cp .env.example .env
```

Fill in your tokens. See `.env.example` for all available variables.

`AGENT_DEFAULT_PROVIDER` selects the runtime (`anthropic` by default, or
`openai`). Provider credentials are validated only for enabled runtimes. OpenAI
uses the Responses-backed `Agent`/`Runner` path; set `OPENAI_BASE_URL` when an
OpenAI-compatible gateway is required. `SMART_REPLY_MODEL` may be set to a
qualified model such as `openai/gpt-5.6-luna`; otherwise smart replies use a
cheap model for the selected provider. Keep `OPENAI_TRACING_ENABLED=false`
unless tracing data handling has been reviewed.

Deployment modes are selected by which provider credentials are present:

- Anthropic-only: keep `AGENT_DEFAULT_PROVIDER=anthropic` and omit
  `OPENAI_API_KEY`.
- OpenAI-only: set `AGENT_DEFAULT_PROVIDER=openai`, use a qualified
  `AGENT_DEFAULT_MODEL`, and omit Anthropic credentials.
- Mixed: configure both credentials; qualified channel/request models select
  the runtime with no automatic fallback.

OpenAI continuation defaults to stored Responses via
`OPENAI_SESSION_MODE=previous_response_id`. If response storage is disabled,
set both `OPENAI_STORE_RESPONSES=false` and
`OPENAI_SESSION_MODE=sdk_session`; invalid combinations fail at startup.

An optional paid smoke check uses the low-cost configured model and never logs
credentials or provider response bodies:

```bash
pnpm smoke:openai
```

### 4. Configure the Bot

Copy the example configs and customize for your workspace:

#### Required

| Example file                                      | Copy to                                   | Purpose                                                     |
| ------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| `config/example-emojis.yaml`                      | `config/emojis.yaml`                      | Emoji reactions for thinking, completion, errors            |
| `config/example-tool-allowlist.yaml`              | `config/tool-allowlist.yaml`              | Role-based tool access control (key order = role hierarchy) |
| `config/example-tool-denylist.yaml`               | `config/tool-denylist.yaml`               | Tools the bot must never use                                |
| `config/instructions/example-general-context.txt` | `config/instructions/general-context.txt` | Base system prompt injected into every response             |

#### Optional

| Example file                                             | Copy to                               | Purpose                                                                |
| --------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| `config/example-channels.yaml`                           | `config/channels.yaml`                | Channel auto-reply routing, keyword triggers, ephemeral summaries      |
| `config/instructions/example-channel.txt`                | `config/instructions/<name>.txt`      | Channel-specific system prompt context (referenced by `channels.yaml`) |
| `config/subagents/example-subagents.yaml`                | `config/subagents/<name>.yaml`        | Sub-agents for validation or post-processing                           |
| `config/approvable-actions/example-approvable-action.ts` | `config/approvable-actions/<name>.ts` | Human-in-the-loop actions (auto-discovered)                            |
| `data/example-employees.yaml`                            | `data/employees.yaml`                 | Employee directory for role assignment and people lookups              |
| `mcp-servers.example.json`                               | `mcp-servers.json`                    | MCP server connections (GitHub, Slack, Jenkins, etc.)                  |

Quick start:

```bash
cp .env.example .env
cp config/example-emojis.yaml config/emojis.yaml
cp config/example-tool-allowlist.yaml config/tool-allowlist.yaml
cp config/example-tool-denylist.yaml config/tool-denylist.yaml
cp config/instructions/example-general-context.txt config/instructions/general-context.txt
```

### 5. Run

```bash
pnpm dev    # development (auto-reload)
pnpm run build && pnpm run prod  # production
```

### Provider and tool migration

Models may be qualified per channel or request, for example
`openai/gpt-5.6-luna` or `anthropic/claude-sonnet-5`. Existing unqualified
Claude model names and legacy tool names remain supported. New provider-neutral
tool identities are preferred in allowlists:

```yaml
member:
  - workspace/read_file
  - workspace/list_files
  - workspace/search_text
  - mcp:slack/slack_search_messages
```

Global deny rules still win. `Bash(...)` is Anthropic-only and is never mapped
to OpenAI shell access. OpenAI v1 exposes only bounded workspace read/list/search
function tools; it does not provide arbitrary shell or file-write tools. Custom
actions continue to use the existing Slack confirmation workflow, and OpenAI
subagents are manager-style agents-as-tools intersected with the parent policy.

## Usage

- **DMs**: responds to all messages
- **Configured channels**: auto-replies based on `channels.yaml` rules
- **All other channels**: responds only when @-mentioned
- **File uploads**: supports images, code files, PDFs, and documents

## Testing

```bash
pnpm test --runInBand       # run all tests
pnpm exec jest --watch      # re-run on file changes
pnpm exec jest src/logger   # run tests matching a pattern
```

Tests use [Jest](https://jestjs.io/) with `ts-jest`. Test files live next to their source files as `*.test.ts`.

## License

Apache 2.0 — see [LICENSE](LICENSE).

Duolingo is hiring! Apply at https://www.duolingo.com/careers
