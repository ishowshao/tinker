# Tinker

**Tinker** is a personal coding-agent harness — an interactive TUI (Terminal User Interface) and one-shot CLI that drives an LLM in an agent loop with file, search, shell, and MCP tools to read and modify a local workspace.

**Tinker is designed for models that work over extremely long horizons — potentially as persistent agents that continue indefinitely, rather than as disposable chat sessions.** Its architecture treats the model's context window as a bounded working set, not as the source of truth. Immutable canonical history, durable sessions, protocol-safe recovery, deterministic context revisions, Recall-addressable cold state, and context-pressure management allow work to continue across compaction, process restarts, and context-window limits.

This does not pretend that any model has infinite tokens or guarantee that it will recall every relevant fact. It means the harness is designed so that history remains durable and recoverable while the model repeatedly operates on a bounded, valid view of an ongoing session.

## Features

- **Interactive TUI**: Full terminal user interface with session management, prompt history, and slash commands.
- **One-shot CLI**: Run a single prompt non-interactively with `tinker run "prompt"`.
- **Built-in tools**:
  - `Glob` / `Grep` — Find and search files by pattern or content
  - `Read` / `Write` / `Edit` — File I/O with content hashing and concurrent-modification protection
  - `Delete` — Delete one existing regular file without directory or symlink support
  - `Bash` — Run foreground, background, and PTY shell commands with per-task working directories
  - `UpdatePlan` — Track a complete ordered task plan and its progress
  - `TaskList` / `TaskOutput` / `TaskInput` / `TaskStop` — Inspect, interact with, and stop long-running shell tasks
  - `WebSearch` — Search the web via Exa API
  - `WebFetch` — Fetch and refine web page content (local, browser, or Exa backend)
  - `RecallSearch` / `RecallGet` — Search or retrieve model-visible history from the current session or an explicitly selected session
- **Agent Skills**: Discover compatible `SKILL.md` packages at project and user
  scope, disclose their catalog progressively, and keep activated instructions
  durable across context compaction and session resume.
- **MCP integration**: Connect external [Model Context Protocol](https://modelcontextprotocol.io) servers — their tools are dynamically registered as `mcp__<server>__<tool>`.
- **Session persistence**: Sessions are persisted via SQLite, supporting session resume, history recall, and a catalog to browse and switch between sessions.
- **Observation system**: Tool execution results are formatted into structured text that the model sees, with separate raw results for event logs and TUI display.
- **Turn cancellation**: Users can cancel an ongoing turn safely, with protocol-safe synthetic tool messages.
- **Context metering**: Budget-aware context management with protocol validation before sending requests to the model.
- **Deterministic context compaction**: Idle sessions can swap eligible historical tool output into Recall-addressable placeholders without calling the model.
- **Infinite Context architecture**: Immutable canonical history, deterministic context revisions, Recall-addressable cold state, and qualified prefix retirement support sessions designed to continue indefinitely without pretending the model has infinite tokens. See the [technical design](docs/infinite-context-technical-design.md).
- **Choice of models**: Uses an OpenAI-compatible Chat Completions transport with
  explicit model and context limits. Actual provider support must be established
  by a qualification matrix; transport compatibility alone is not a guarantee.

### Reading another session's history

Both Recall tools accept an optional `sessionId` (a canonical session UUID).
Omitting it keeps the current-session behavior. In the TUI or one-shot CLI, the
agent can use a session ID you supply or a Memory result's `sourceSessionId`:

```ts
RecallSearch({ sessionId: sourceSessionId, query: "distinctive-anchor" })
RecallGet({ sessionId: sourceSessionId, source: "ctx://message/<message-UUID>" })
```

Reuse the same `sessionId` for Get and subsequent pages. Search's
`snapshot_through_ordinal`, ordinals and turn numbers belong to that session only.
Results identify their source session and workspace. Missing, ambiguous, unsafe,
unsupported or corrupt sessions return errors; Recall never silently switches
back to the current session. Memory is not required.

**Data scope:** explicit session selection can read other workspaces under the
configured Tinker home (`TINKER_HOME` overrides the OS home). Retrieved text is
sent to the **current model provider** and saved as a tool result in the **current
session**, including when projects or providers differ. There is no additional
cross-workspace confirmation dialog.

External history uses short read-only SQLite snapshots, without resuming the
source session, taking its execution lock, repairing indexes or migrating its
schema. Only the current readable schema is supported. Active writers' committed
history is readable; an open/interrupted turn may be incomplete. Historical
instructions, Skills and authorizations are not activated, and content hashes
prove storage consistency, not truth. Use Read/Grep to verify current facts.
Original workspaces need not still exist. SQLite WAL reads can coordinate through
SHM; read-only access does not promise that an active writer's directory remains
byte-for-byte unchanged. See the [design](docs/recall-session-selection-design.md).

The session-selection Recall surface was re-evaluated with the frozen active
Recall qualification policy. It missed the Search → Get threshold, although all
Recall-only tasks passed. An explicit product decision preserves the previously
enabled automatic swap and prefix retirement. A subsequent explicit decision
extends continuity to the reviewed description-only cleanup, binding its exact
tool hash separately from the original evaluated hash and report pair. The cleaned
wording has not been re-evaluated with the live model. Triggers and execution
safeguards are unchanged. This is not a qualification pass or a blanket exemption
for future changes. The
[qualification report](docs/recall-session-selection-qualification-deepseek-v4-flash.json)
retains the measured failure; its automation flags describe the frozen evaluator's
recommendation, not this subsequent runtime continuity decision.

## Quick Start

### Install with your existing agent

If you already use a coding agent, you can ask it to read Tinker's documentation, install the package, and prepare a complete local configuration for you. Values it cannot safely determine can be left as clearly named placeholders; when setup is complete, the agent should tell you exactly which file to edit and what each placeholder expects.

Copy and send this prompt to your existing agent:

```text
Open https://github.com/ishowshao/tinker and read Tinker's README and linked model-configuration documentation, then install and configure Tinker on this machine.

Create a complete model profile configuration in an appropriate local file. Use clearly named placeholders for any required values that cannot be determined from the documentation or the current environment; do not invent API credentials, endpoint URLs, model names, or model limits. Configure Tinker to use that file, and verify the installation and configuration as far as possible without making a live model request.

When finished, tell me:
1. the exact path of the configuration file you created;
2. every placeholder I still need to replace;
3. what value each placeholder expects;
4. any command I need to run after filling them in;
5. the command to start Tinker.

Do not ask me for the missing values during setup unless proceeding would be unsafe. Prefer creating a structurally complete configuration with placeholders so I can fill them in locally afterward.
```

### Install manually

```bash
npm install --global tinker-agent

# Start the interactive TUI
tinker

# Run a one-shot prompt
tinker run "explain the project structure"

# Inspect the installed command surface
tinker --help
tinker --version
```

The npm package includes its own Bun runtime. To run Tinker from a source checkout,
install Bun 1.3.14 or later, then use `bun install` followed by `bun run tinker`.

`run` accepts exactly one Prompt source: one shell-quoted argument, explicit stdin,
or a UTF-8 text file. Use stdin for multiline code, private patches, or Prompt text
containing secrets so it does not become a command-line argument:

```bash
printf '%s\n' 'Review `$HOME`, *.ts, and "quotes" literally.' | tinker run --stdin
tinker run --file prompts/review.md
```

Tinker does not reconstruct shell expansions or join multiple positional arguments.
Use `tinker run "one quoted prompt"`; the former unquoted variadic form now fails
with a usage error. File paths are resolved from the current directory and may point
outside the configured workspace. You are responsible for Prompt-file permissions
and cleanup.

## Commands

The installed package exposes this public CLI:

<!-- BEGIN GENERATED: PUBLIC CLI COMMANDS -->
| Command | Description |
| --- | --- |
| `tinker` | Start the interactive terminal interface. |
| `tinker --profile <profile-name>` | Start the TUI with a selected model profile. |
| `tinker run [--profile <profile-name>] [--yolo] <prompt>` | Submit one shell-quoted prompt argument. |
| `tinker run [--profile <profile-name>] [--yolo] --stdin` | Read the prompt from standard input until EOF. |
| `tinker run [--profile <profile-name>] [--yolo] --file <path>` | Read the prompt from a UTF-8 text file. |
| `tinker update` | Update the global npm installation from the official npm registry. |
| `tinker --help` | Show top-level CLI help. |
| `tinker help run` | Show one-shot command help. |
| `tinker help update` | Show update command help. |
| `tinker --version` | Print the installed package version. |
<!-- END GENERATED: PUBLIC CLI COMMANDS -->

`tinker update` is available only to direct npm global installations. It checks
the `latest` stable version on the official npm registry, updates that same global
prefix, and exits without loading model configuration or starting a session.

Repository development commands are separate from the installed CLI:

```bash
bun install              # Install dependencies
bun run tinker           # Start the interactive TUI
bun test                 # Run test suite
bun run typecheck        # TypeScript type checking (tsc --noEmit)
bun run lint             # ESLint (zero warnings required)
bun run format           # Biome code formatting
bun run check            # Full repository quality gate
```

`bun run check` runs type checking, formatting verification, linting, the README
contract check, the full test suite, and the benchmark smoke check. Documentation
checking is read-only; use `bun run docs:generate` explicitly after changing a
public declaration.

## Agent Skills

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

Set `TINKER_MODELS` to use a profile file. Without it, the env-mode model fields
are required. Boolean environment values accept case-insensitive `true/false`,
`1/0`, `yes/no`, and `on/off`.

<!-- BEGIN GENERATED: PUBLIC ENVIRONMENT VARIABLES -->
| Variable | Area | Applies | Required | Type | Default | Secret | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `TINKER_MODELS` | Model | All modes | No | Non-empty string | — | No | Optional model profiles JSON path. A leading ~ expands to the home directory; other relative paths resolve from the process cwd. |
| `TINKER_MODEL` | Model | Env mode | Env mode | Non-empty string | — | No | Model name used when model profiles are not configured. |
| `TINKER_API` | Model | Env mode | No | Non-empty string | `"chat-completions"` | No | Model API adapter: "chat-completions" or "responses". |
| `TINKER_BASE_URL` | Model | Env mode | Env mode | Non-empty string | — | No | OpenAI-compatible API root URL; do not append /chat/completions or /responses. |
| `TINKER_API_KEY` | Model | Env mode | Env mode | Non-empty string | — | Yes | API credential for the configured model endpoint. |
| `TINKER_CONTEXT_WINDOW_TOKENS` | Model | Env mode | Env mode | Positive integer | — | No | Model context-window size in tokens. |
| `TINKER_MAX_SUPPORTED_OUTPUT_TOKENS` | Model | Env mode | Env mode | Positive integer | — | No | Maximum output-token count supported by the model; must not exceed the context window. |
| `TINKER_INCLUDE_REASONING_CONTENT` | Model | Env mode | No | Boolean | `false` | No | Replay provider reasoning_content in Chat Completions history; ignored by Responses. |
| `TINKER_STREAM` | Model | Env mode | No | Boolean | `true` | No | Use streaming transport for the selected model API. |
| `TINKER_WEBFETCH_REFINE_MODEL` | Model | Env mode | No | Non-empty string | — | No | Optional WebFetch refiner model; currently must match TINKER_MODEL. |
| `TINKER_WORKSPACE` | Workspace | All modes | No | Non-empty string | Process cwd | No | Workspace path. A leading ~ expands to the home directory; other relative paths resolve from the process cwd. |
| `TINKER_MAX_ITERATIONS` | Workspace | All modes | No | Positive integer | `65536` | No | Maximum agent-loop iterations per turn. |
| `EXA_API_KEY` | Tooling | All modes | No | Non-empty string | — | Yes | Enables WebSearch and the Exa WebFetch backend when set. |
| `TINKER_MCP_TIMEOUT_MS` | Tooling | All modes | No | Positive integer | `60000` | No | MCP tool-call timeout in milliseconds. |
| `TINKER_MCP_MAX_OBSERVATION_CHARS` | Tooling | All modes | No | Positive integer | `40000` | No | Maximum model-visible characters in one MCP result. |
| `TINKER_BASH_DEFAULT_TIMEOUT_MS` | Tooling | All modes | No | Positive integer | `5000` | No | Default Bash foreground timeout in milliseconds. |
| `TINKER_BASH_MAX_TIMEOUT_MS` | Tooling | All modes | No | Positive integer | `600000` | No | Maximum Bash foreground timeout in milliseconds. |
| `TINKER_YOLO` | Tooling | All modes | No | Boolean | `false` | No | Allow high-confidence destructive Bash commands without confirmation. |
| `TINKER_GREP_TIMEOUT_MS` | Tooling | All modes | No | Positive integer | `20000` | No | Bundled ripgrep invocation timeout in milliseconds. |
| `TINKER_GREP_MAX_BUFFER_BYTES` | Tooling | All modes | No | Positive integer | `20000000` | No | Maximum buffered output from one ripgrep invocation. |
| `TINKER_WEBFETCH_REFINE_THRESHOLD` | Tooling | All modes | No | Positive integer | `2000` | No | Content-length threshold that enables WebFetch refinement. |
| `TINKER_RIPGREP_PATH` | Tooling | All modes | No | Non-empty string | Bundled ripgrep | No | Explicit diagnostic override for the bundled ripgrep executable. |
<!-- END GENERATED: PUBLIC ENVIRONMENT VARIABLES -->

Model and estimator API keys are sent to their configured external endpoints.
`EXA_API_KEY` is sent to Exa when WebSearch or the Exa WebFetch backend is used.
Keep configuration files private and review each service's data-handling policy.

### Multi-Model Profiles

Set `TINKER_MODELS` to point to a JSON file with multiple named model
profiles. When set, the profile's `default` field selects the startup model, and
the `/model` slash command (available in new sessions before any turns) lets you
switch to another profile. If `TINKER_MODELS` is not set, Tinker falls back to
the individual `TINKER_*` environment variables. A configured profiles file must
exist and be valid; Tinker does not silently fall back when it cannot be loaded.

For provider-specific examples and guidance on API adapters, model capabilities,
reasoning efforts, and context limits, see the
[`.tinker/models.json` provider configuration guide](docs/models-json-provider-guide.md).

<!-- BEGIN GENERATED: MODEL PROFILE FIELDS -->
Profile fields:

| Field | Required | Type / constraint | Default | Secret | Description |
| --- | --- | --- | --- | --- | --- |
| `model` | Yes | Non-empty string | — | No | Provider model name. |
| `api` | No | Non-empty string | `"chat-completions"` | No | Model API adapter: "chat-completions" or "responses". |
| `apiBase` | Yes | Non-empty string | — | No | OpenAI-compatible API root URL; do not append /chat/completions or /responses. |
| `apiKey` | Yes | Non-empty string | — | Yes | API credential for this profile. |
| `contextWindowTokens` | Yes | Positive integer | — | No | Model context-window size in tokens. |
| `maxSupportedOutputTokens` | Yes | Positive integer | — | No | Maximum output-token count supported by the model; must not exceed contextWindowTokens. |
| `reasoning` | No | Object | — | No | Provider-specific reasoning efforts and the default for each new session runtime. |
| `includeReasoningContent` | No | JSON boolean | `false` | No | Replay provider reasoning_content in Chat Completions history; ignored by Responses. |
| `stream` | No | JSON boolean | `true` | No | Use streaming transport for the selected model API. |
| `inputModalities` | No | Normalized modality array | `["text"]` | No | Accepted model input modalities; normalizes to ["text"] or ["text", "image"]. |
| `toolResultModalities` | No | Normalized modality array | `["text"]` | No | Accepted tool-result modalities; normalizes to ["text"] or ["text", "image"]. |

`reasoning` fields:

| Field | Type / constraint | Description |
| --- | --- | --- |
| `supportedEfforts` | Non-empty unique string array | Provider-supported effort values exposed by the /reasoning command. |
| `defaultEffort` | Non-empty string listed above | Effort used whenever a session runtime is created or reopened. |

The optional `reasoning` object declares provider-specific effort values. Efforts must be unique non-whitespace strings, `reset` is reserved by the TUI command, and `defaultEffort` must appear in `supportedEfforts`. Omitting `reasoning` sends no effort parameter and disables `/reasoning` for that profile.

Text-only profile example:

```json
{
  "default": "text",
  "profiles": {
    "text": {
      "model": "example-text-model",
      "api": "chat-completions",
      "apiBase": "https://api.example.com/v1",
      "apiKey": "your-model-api-key",
      "contextWindowTokens": 128000,
      "maxSupportedOutputTokens": 8192,
      "reasoning": {
        "supportedEfforts": [
          "low",
          "medium",
          "high"
        ],
        "defaultEffort": "medium"
      },
      "includeReasoningContent": false,
      "stream": true,
      "inputModalities": [
        "text"
      ],
      "toolResultModalities": [
        "text"
      ]
    }
  }
}
```

Image-capable profile example:

```json
{
  "default": "image",
  "profiles": {
    "image": {
      "model": "example-vision-model",
      "api": "responses",
      "apiBase": "https://api.example.com/v1",
      "apiKey": "your-model-api-key",
      "contextWindowTokens": 128000,
      "maxSupportedOutputTokens": 8192,
      "reasoning": {
        "supportedEfforts": [
          "low",
          "medium",
          "high"
        ],
        "defaultEffort": "medium"
      },
      "includeReasoningContent": false,
      "stream": true,
      "inputModalities": [
        "text",
        "image"
      ],
      "toolResultModalities": [
        "text",
        "image"
      ]
    }
  }
}
```

The top-level `memory` object is optional. When present, every field below is required. It enables completed-turn extraction and `MemorySearch` only in the TUI; one-shot runs do not load memory.

| Field | Required | Type / constraint | Secret | Description |
| --- | --- | --- | --- | --- |
| `profile` | Yes | Non-empty string | No | Existing model profile used for completed-turn atomic-memory extraction. |
| `embedding` | Yes | Object | Yes | Single embedding profile for the global memory database. |

`memory.embedding` fields:

| Field | Required | Type / constraint | Secret | Description |
| --- | --- | --- | --- | --- |
| `name` | Yes | Non-empty string | No | Stable identity for the embedding space. |
| `kind` | Yes | Literal `"openai-compatible"` | No | Embedding transport kind. |
| `model` | Yes | Non-empty string | No | Embedding provider model name. |
| `apiBase` | Yes | Non-empty string | No | OpenAI-compatible API base URL. |
| `apiKey` | Yes | Non-empty string | Yes | Embedding provider credential. |
| `dimensions` | Yes | Positive integer | No | Fixed vector dimensions for the global memory database. |

Enabling memory sends completed-turn text (not image bytes) to `memory.profile`, and sends extracted candidates plus search queries to the embedding endpoint. Derived memories are stored in `~/.tinker/memory/memory.sqlite`; newly inserted memory text is appended to the private development log `~/.tinker/memory/extracted-memories.log`.

Atomic-memory profile example:

```json
{
  "default": "text",
  "profiles": {
    "text": {
      "model": "example-text-model",
      "api": "chat-completions",
      "apiBase": "https://api.example.com/v1",
      "apiKey": "your-model-api-key",
      "contextWindowTokens": 128000,
      "maxSupportedOutputTokens": 8192,
      "reasoning": {
        "supportedEfforts": [
          "low",
          "medium",
          "high"
        ],
        "defaultEffort": "medium"
      },
      "includeReasoningContent": false,
      "stream": true,
      "inputModalities": [
        "text"
      ],
      "toolResultModalities": [
        "text"
      ]
    }
  },
  "memory": {
    "profile": "text",
    "embedding": {
      "name": "example-embedding-space",
      "kind": "openai-compatible",
      "model": "example-embedding-model",
      "apiBase": "https://embeddings.example.com/v1",
      "apiKey": "your-embedding-api-key",
      "dimensions": 1024
    }
  }
}
```
<!-- END GENERATED: MODEL PROFILE FIELDS -->

Set `api` to `"responses"` to use the standard Responses API. Keep `apiBase`
at the API root—such as `https://api.openai.com/v1`—because Tinker appends the
`/responses` route. Responses requests use the stateless common subset
(`store: false` with complete input history), so the same adapter works with
OpenAI and compatible providers that do not implement stored response chaining.

You can also select profiles explicitly for the TUI or one-shot command:

```bash
tinker --profile text
tinker run --profile text "explain the project structure"
```

Switching models creates a new session. The previous session is preserved and
can be resumed with `/resume`. Each session records its profile name, and resume
reopens the session with that profile. Resume fails clearly if the profile is no
longer present or its runtime contract has changed. Older sessions without a
stored profile name can resume only when their model name uniquely matches one
configured profile.

### Image Input

Image attachment is enabled only for a profile whose `inputModalities` explicitly
includes `image`. In the interactive
TUI, type `@` and select a file that is inside the workspace and visible to the
workspace search rules. One-shot commands, clipboard image bytes, remote URLs, and
files outside or ignored by the workspace search are not supported.

Tinker accepts PNG (not APNG), JPEG, and static WebP. It rejects GIF, animated
WebP, and other formats. A message and provider request may contain at most eight
images; each image may be at most 20 MiB, 4096 pixels on either edge, and 8,847,360
pixels in total. Provider requests preserve smaller images and proportionally
downscale larger images to a maximum 2048-pixel long edge. Context planning uses
fixed local token buckets derived from the materialized dimensions and performs no
independent token-estimator request. See the
[`image token bucket design`](docs/image-token-bucket-estimation-design.md) and
[`multimodal image input design`](docs/multimodal-image-input-design.md) for the
complete fixed policy and persistence contract.

`ViewImage(file_path)` is registered only when the selected profile declares both
`inputModalities: ["text", "image"]` and
`toolResultModalities: ["text", "image"]`. The first implementation supports
image tool results through the Responses adapter; Chat Completions remains
text-only for tool results. Relative paths stay inside the workspace, absolute
paths may explicitly select an external local file, and symbolic links are
rejected. Canonical history stores content-addressed image references rather than
Base64, while stdout, TUI, Recall, and logs show deterministic text summaries.
See the [`ViewImage tool design`](docs/view-image-tool-design.md) for the complete
capability, persistence, provider, and compaction contract.

### Built-in Slash Commands

<!-- BEGIN GENERATED: BUILT-IN SLASH COMMANDS -->
| Command | Description |
| --- | --- |
| `/status` | Show session and context details |
| `/skills` | Show available and active Agent Skills |
| `/mcp` | Show MCP servers and runtime tools |
| `/yolo [on\|off]` | Show or change destructive Bash confirmation |
| `/memory` | Browse stored global memories |
| `/compact [retire]` | Swap tool output or retire a cold history prefix |
| `/undo` | Undo the latest Write/Edit/Delete turn |
| `/clear` | Start a new session and clear conversation |
| `/fork` | Clone the current session |
| `/view <path>` | View a local UTF-8 text file |
| `/copy` | Copy the last response as Markdown |
| `/model [profile-name]` | Switch model profile (new session) |
| `/reasoning [effort\|reset]` | Show or change reasoning effort for this session runtime |
| `/resume [session-id]` | Choose or resume a session |
| `/session delete <session-id> --confirm` | Manage stored sessions |
| `/quit` | Exit the TUI |
<!-- END GENERATED: BUILT-IN SLASH COMMANDS -->

`/view` opens a readable UTF-8 text file in a full-window viewer. Relative paths
must remain inside the workspace; absolute paths may point outside it. `/compact`
swaps eligible historical tool output, while `/compact retire` retires a complete
cold prefix whose original history remains available through `Recall`. `/copy`
copies the last completed assistant response as raw Markdown.

Profiles that declare `reasoning` expose `/reasoning` as a session-runtime
control. `/reasoning <effort>` temporarily selects one of the profile's
`supportedEfforts`, and `/reasoning reset` restores `defaultEffort`. The
selection is not written to configuration or canonical history: `/clear`,
`/fork`, `/model`, `/resume`, and a TUI restart create a new runtime from the
profile default. Responses requests send `reasoning.effort`; Chat Completions
requests send `reasoning_effort`. Press `Ctrl+R` while the prompt is idle to cycle
through `supportedEfforts` in profile order, wrapping from the last effort to the
first. When configured, the TUI information line shows the live effort immediately
after the model name, for example `gpt-5.6-sol max`.

### Project Custom Slash Commands

The TUI loads optional project-scoped prompt aliases from `.tinker.json` in the
workspace root:

```json
{
  "version": 1,
  "slashCommands": [
    {
      "name": "git-commit-and-push",
      "description": "Commit and push workspace changes",
      "prompt": "Please inspect the workspace changes, create an appropriate commit, and push it."
    }
  ]
}
```

Enter `/git-commit-and-push` to submit its configured prompt as an ordinary user
turn. Built-in slash commands appear first in suggestions, followed by project
commands in configuration order. Custom commands accept no arguments and cannot
override built-ins. The optional configuration is loaded once at TUI startup,
must be valid when present, and has a 1 MiB size limit. It is not loaded by the
one-shot `tinker run` command. See
[`docs/project-custom-slash-commands-design.md`](docs/project-custom-slash-commands-design.md)
for the full contract.

### Global Runtime Data

Tinker keeps private runtime state in a global home directory instead of inside
your projects. Each workspace maps to
`~/.tinker/projects/<workspace-slug-hash>/` — the slug comes from the workspace
directory name and the hash from its canonical absolute path, so one project
always resolves to one storage directory even when reached through symlinks.
That directory holds per-session SQLite databases, event logs, and observation
logs (`sessions/<id>/`), background Bash task logs (`bash/`), imported image
assets (`assets/images/`), and prompt history (`prompt-history.jsonl`).
Workspaces stay clean: no `.tinker/` directory is created inside them.

Set `TINKER_HOME` to relocate the global home (default: the OS home directory).
Global memory lives in `<home>/.tinker/memory/` and the Chrome bridge host in
`<home>/.tinker/chrome/`. MCP server configuration is loaded from
`<workspace>/.mcp.json`; project slash commands are loaded from
`<workspace>/.tinker.json`.

`Read` has a fixed 262144-byte (256 KiB) content limit per call. A successful
call always returns the complete requested line range. Use `offset` and `limit`
to page through larger files; oversized requests fail instead of returning
truncated content.

`Delete` removes one existing regular file by workspace-relative or absolute path.
It rejects directories and symbolic links, and clears any in-memory file snapshot
only after the removal succeeds.

## Project Structure

```
tinker/
├── src/
│   ├── cli/           # Entry points (tui, run), config
│   ├── agent/         # Agent loop, session ledger, turn cancellation, context metering
│   ├── tools/         # Tool executors (bash, glob, grep, read, write, edit, delete, recall, etc.)
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
└── package.json

Runtime data lives in ~/.tinker/ (sessions, bash tasks, assets), not in the repo.
```

## Design Philosophy

- **Fast-fail**: Validate assumptions early and return clear errors close to the source. Structured failures allow the model to correct and retry.
- **Model sees only text**: Tool execution results are rendered into readable text for the model. Raw result data with extra detail is kept for event logs and the TUI.
- **Protocol safety**: All tool calls produce protocol-safe messages — even cancellations, fatal errors, or interruptions generate well-formed tool messages so the agent loop can continue.
- **Long-horizon continuity**: Treat the context window as a replaceable working set over durable canonical history. Sessions should remain resumable and historically recoverable across compaction, interruption, and process restarts.
- **Session durability**: Every turn, iteration, and tool call is committed to the SQLite ledger before the model is called, enabling reliable resume and history recall.

## Requirements

- Node.js 20 or later and npm for the global package installation
- [Bun](https://bun.sh) 1.3.14 or later for development from source
- A configured OpenAI-compatible Chat Completions endpoint; transport compatibility
  alone does not establish provider qualification

## Security

Tinker is an agent with permission to read and modify files and run shell commands in
the selected workspace. Review its configuration and model-provider data policies
before using it with sensitive source code. Please report vulnerabilities privately
through [GitHub Security Advisories](https://github.com/ishowshao/tinker/security/advisories/new).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development
workflow and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations.

## Attribution

The original Tinker Infinite Context architecture and its initial implementation were
designed and developed by **ishowshao**. See [NOTICE](NOTICE) for the attribution that
accompanies distributions and derivative works.

## License

Licensed under the [Apache License 2.0](LICENSE).
