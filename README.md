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
- **MCP integration**: Connect external [Model Context Protocol](https://modelcontextprotocol.io) servers — their tools are dynamically registered as `mcp__<server>__<tool>`.
- **Session persistence**: Sessions are persisted via SQLite, supporting session resume, history recall, and a catalog to browse and switch between sessions.
- **Observation system**: Tool execution results are formatted into structured text that the model sees, with separate raw results for event logs and TUI display.
- **Turn cancellation**: Users can cancel an ongoing turn safely, with protocol-safe synthetic tool messages.
- **Context metering**: Budget-aware context management with protocol validation before sending requests to the model.
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

## Configuration

Tinker is configured via environment variables:

| Variable | Default | Description |
|---|---|---|
| `TINKER_MODEL` | `deepseek-v4-flash` | Model name |
| `TINKER_BASE_URL` | `https://api.deepseek.com` | API base URL |
| `TINKER_API_KEY` | — | API key |
| `TINKER_WORKSPACE` | `process.cwd()` | Workspace root |
| `TINKER_MAX_ITERATIONS` | `512` | Max agent loop iterations per turn |
| `TINKER_MAX_DISPLAYED_BYTES` | `20000` | Max bytes displayed per Read |
| `EXA_API_KEY` | — | Enables WebSearch tool |
| `TINKER_MCP_CONFIG` | — | Path to MCP server config JSON |
| `TINKER_EVENT_LOG` | `$TINKER_DIR/events.jsonl` | Event log path |
| `TINKER_SESSION_DIR` | `$TINKER_DIR/sessions` | Session storage directory |
| `TINKER_INCLUDE_REASONING` | `false` | Include model reasoning in output |
| `TINKER_TASK_STOP_GRACE_MS` | `5000` | Grace period before SIGKILL |
| `TINKER_MCP_TIMEOUT_MS` | `30000` | MCP tool timeout |
| `TINKER_CONTEXT_BUDGET_TOKENS` | `128000` | Context budget in tokens |

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
