# Tinker

**Tinker** is a personal coding agent — an interactive TUI (Terminal User Interface) and one-shot CLI tool that drives an LLM in an agent loop with file, search, shell, and MCP tools to read and modify a local workspace.

Built with [Bun](https://bun.sh) + TypeScript ESM, powered by [Ink](https://github.com/vadimdemedes/ink) (React for CLIs).

## Features

- **Interactive TUI**: Full terminal user interface with session management, prompt history, and slash commands.
- **One-shot CLI**: Run a single prompt non-interactively with `tinker run "prompt"`.
- **Built-in tools**:
  - `Glob` / `Grep` — Find and search files by pattern or content
  - `Read` / `Write` / `Edit` — File I/O with content hashing and concurrent-modification protection
  - `Bash` — Run shell commands (foreground and background) with per-task working directories
  - `TaskList` / `TaskOutput` / `TaskStop` — Manage long-running background shell tasks
  - `WebSearch` — Search the web via Exa API
  - `WebFetch` — Fetch and refine web page content (local, browser, or Exa backend)
  - `Recall` — Search or retrieve model-visible history from the current session
- **Agent Skills**: Discover compatible `SKILL.md` packages at project and user
  scope, disclose their catalog progressively, and keep activated instructions
  durable across context compaction and session resume.
- **MCP integration**: Connect external [Model Context Protocol](https://modelcontextprotocol.io) servers — their tools are dynamically registered as `mcp__<server>__<tool>`.
- **Session persistence**: Sessions are persisted via SQLite, supporting session resume, history recall, and a catalog to browse and switch between sessions.
- **Observation system**: Tool execution results are formatted into structured text that the model sees, with separate raw results for event logs and TUI display.
- **Turn cancellation**: Users can cancel an ongoing turn safely, with protocol-safe synthetic tool messages.
- **Context metering**: Budget-aware context management with protocol validation before sending requests to the model.
- **Deterministic context compaction**: Idle sessions can swap eligible historical tool output into Recall-addressable placeholders without calling the model.
- **Choice of models**: Supports any OpenAI-compatible API (defaults to DeepSeek). Configurable via environment variables.

## Quick Start

```bash
# Clone and install
git clone <repo>
cd tinker
bun install

# Start the interactive TUI
bun run tinker

# Run a one-shot prompt
bun run tinker run "explain the project structure"
```

### Slash Commands

- `/view <path>` — Open a readable UTF-8 text file in a full-window viewer. Relative
  paths must remain inside the workspace; absolute paths may point outside it. Use
  the keyboard or mouse wheel to scroll and press `Esc` to close the viewer.
- `/status` — Show session and context details.
- `/skills` — Show available skills, their scope and active state, plus user skills
  shadowed by a project skill.
- `/compact` — Deterministically compact eligible historical tool output while the
  session is idle.
- `/compact retire` — Retire a complete cold history prefix from the active request;
  the original history remains available through `Recall`.
- `/model [profile-name]` — Choose a model profile for a new session.
- `/resume [session-id]` — Choose or directly resume a stored session.
- `/session delete <session-id> --confirm` — Delete a stored session.
- `/quit` — Exit the TUI.

### Agent Skills

Tinker scans `<workspace>/.agents/skills/` and `~/.agents/skills/` once when a new
or resumed runtime starts. Each direct child skill must contain a strictly valid
`SKILL.md`; an invalid discovered skill stops activation with a clear error. A
project skill wins when both scopes define the same name.

Only skill names and descriptions are initially exposed to the model. When the
model selects a matching skill through the conditional `Skill` tool, Tinker sends
the complete snapshotted `SKILL.md` and a bounded listing of its standard resource
directories. Relative resource paths are resolved from that skill's directory and
are read or executed only through Tinker's existing tools. Activated instructions
remain in the current system surface across later turns and compaction; resume
rebinds them to the current validated files.

Skill content is not local-only after activation: it is sent to the configured
model provider and persisted in the private session SQLite database, event log,
and observation log, just like other model-visible file content. `/skills` is
read-only and does not rescan, install, activate, or remove skills.

## Configuration

Tinker is configured via environment variables:

| Variable | Default | Description |
|---|---|---|
| `TINKER_MODEL` | — | Required model name when `TINKER_MODELS` is not set |
| `TINKER_BASE_URL` | — | Required API base URL |
| `TINKER_API_KEY` | — | Required API key |
| `TINKER_MODELS` | — | Path to a multi-model profiles JSON file (see below) |
| `TINKER_WORKSPACE` | `process.cwd()` | Workspace root |
| `TINKER_MAX_ITERATIONS` | `512` | Max agent loop iterations per turn |
| `EXA_API_KEY` | — | Enables WebSearch tool |
| `TINKER_MCP_CONFIG` | — | Path to MCP server config JSON |
| `TINKER_EVENT_LOG` | `$TINKER_DIR/events.jsonl` | Event log path |
| `TINKER_SESSION_DIR` | `$TINKER_DIR/sessions` | Session storage directory |
| `TINKER_INCLUDE_REASONING` | `false` | Include model reasoning in output |
| `TINKER_TASK_STOP_GRACE_MS` | `5000` | Grace period before SIGKILL |
| `TINKER_MCP_TIMEOUT_MS` | `30000` | MCP tool timeout |
| `TINKER_CONTEXT_BUDGET_TOKENS` | `128000` | Context budget in tokens |

### Multi-Model Profiles

Set `TINKER_MODELS` in `.env` to point to a JSON file with multiple named model
profiles. When set, the profile's `default` field selects the startup model, and
the `/model` slash command (available in new sessions before any turns) lets you
switch to another profile. If `TINKER_MODELS` is not set, Tinker falls back to
the individual `TINKER_*` environment variables. A configured profiles file must
exist and be valid; Tinker does not silently fall back when it cannot be loaded.

```json
{
  "default": "deepseek",
  "profiles": {
    "deepseek": {
      "model": "deepseek-chat",
      "apiBase": "https://api.deepseek.com/v1",
      "apiKey": "sk-xxx",
      "contextWindowTokens": 128000,
      "maxSupportedOutputTokens": 8192
    },
    "gpt-4o": {
      "model": "gpt-4o",
      "apiBase": "https://api.openai.com/v1",
      "apiKey": "sk-yyy",
      "contextWindowTokens": 128000,
      "maxSupportedOutputTokens": 16384,
      "includeReasoningContent": true
    }
  }
}
```

You can also start TUI with a specific profile:

```bash
bun run tinker --profile gpt-4o
```

Switching models creates a new session. The previous session is preserved and
can be resumed with `/resume`. Each session records its profile name, and resume
reopens the session with that profile. Resume fails clearly if the profile is no
longer present or its runtime contract has changed. Older sessions without a
stored profile name can resume only when their model name uniquely matches one
configured profile.

`Read` has a fixed 262144-byte (256 KiB) content limit per call. A successful
call always returns the complete requested line range. Use `offset` and `limit`
to page through larger files; oversized requests fail instead of returning
truncated content.

## Commands

```bash
bun install              # Install dependencies
bun run tinker           # Start the interactive TUI
bun run tinker run "..." # Run a one-shot CLI prompt
bun test                 # Run test suite
bun run typecheck        # TypeScript type checking (tsc --noEmit)
bun run lint             # ESLint (zero warnings required)
bun run format           # Biome code formatting
bun run check            # Full check: typecheck + format + lint + test
```

## Project Structure

```
tinker/
├── src/
│   ├── cli/           # Entry points (tui, run), config
│   ├── agent/         # Agent loop, session ledger, turn cancellation, context metering
│   ├── tools/         # Tool executors (bash, glob, grep, read, write, edit, recall, etc.)
│   ├── model/         # Model clients (OpenAI-compatible, fake), chat mapping, preflight
│   ├── mcp/           # MCP server management, tool executor adapter
│   ├── observation/   # Tool result → model-visible text
│   ├── skills/        # Agent Skills discovery, catalog, activation, and context
│   ├── session/       # SQLite session store, catalog, history reader, resume
│   ├── events/        # Event sinks, JSONL log, stdout printer
│   ├── tui/           # Ink/React UI components, projection store, session controller
│   ├── context/       # Context protocol validation, protocol frame construction
│   └── ids/           # Runtime ID generation (UUID v7)
├── docs/              # Design notes and planning documents
├── .tinker/           # Runtime data (sessions, bash tasks, events)
└── package.json
```

## Design Philosophy

- **Fast-fail**: Validate assumptions early and return clear errors close to the source. Structured failures allow the model to correct and retry.
- **Model sees only text**: Tool execution results are rendered into readable text for the model. Raw result data with extra detail is kept for event logs and the TUI.
- **Protocol safety**: All tool calls produce protocol-safe messages — even cancellations, fatal errors, or interruptions generate well-formed tool messages so the agent loop can continue.
- **Session durability**: Every turn, iteration, and tool call is committed to the SQLite ledger before the model is called, enabling reliable resume and history recall.

## Requirements

- [Bun](https://bun.sh) (developed with Bun 1.x)
- A compatible LLM API (defaults to DeepSeek; any OpenAI-compatible API works)

## License

MIT
