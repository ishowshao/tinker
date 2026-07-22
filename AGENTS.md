# Tinker

## What This Project Is

Tinker is a personal coding agent for working inside a local workspace. It is a
Bun-powered TypeScript ESM application with two user interfaces: an interactive
Ink/React terminal UI and a one-shot CLI. Both drive an LLM through an agent loop
that can inspect and modify files, search code, run shell commands, retrieve web
content, recall session history, and call tools exposed by MCP servers.

## Key Architecture

- `src/cli` is the composition root. It loads configuration, model profiles,
  project instructions, Agent Skills, and MCP settings, then creates a runtime
  session for either the TUI or one-shot runner.
- `src/agent/runtime-session.ts` owns the session lifecycle and coordinates the
  agent loop, cancellation, context maintenance, persistence, tools, and event
  delivery. `src/agent/loop.ts` repeatedly builds a model request, validates its
  context budget and protocol, calls the model, executes requested tools, records
  their results, and continues until the model returns a final response.
- `src/context` compiles canonical history into provider-ready context. Context
  revisions, compaction, and prefix retirement may change what is sent to the
  model without mutating the canonical conversation. Retired history remains
  available through Recall.
- `src/session` persists canonical session state in SQLite and provides resume,
  history retrieval, and session catalog operations. SQLite is the recovery
  source of truth; event and observation logs are diagnostic projections.
- `src/model` isolates provider-specific request mapping, streaming, token
  estimation, and preflight checks behind the model client boundary.
- `src/tools` defines built-in tool schemas and executors. MCP tools are adapted
  into the same registry. `src/observation` converts raw tool results into the
  structured text visible to the model.
- `src/events` publishes runtime events to persistence and presentation sinks.
  The TUI in `src/tui` reduces those events into its visible timeline, while
  resumed sessions rebuild the same presentation from stored canonical state.
- `src/skills` discovers and activates Agent Skills. `src/image` owns image
  import, storage, validation, and request materialization.

Keep orchestration in the runtime/session layers, provider logic in `src/model`,
and user-interface behavior in `src/tui` or the CLI. Prefer fast failure at these
boundaries so invalid state does not enter canonical history.

## Quality Gate

When a change includes source code, tests, executable scripts, dependencies, or
build/runtime configuration, run `bun run check` before considering it complete.
It must pass type checking, formatting, linting, tests, and the benchmark smoke
check.
