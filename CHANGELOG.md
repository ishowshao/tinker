# Changelog

All notable user-facing changes to Tinker are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.10.0] - 2026-08-15

### Added

- Add an OpenAI Responses API adapter selectable per model profile, including
  stateless request mapping, streaming, reasoning output, tool calls, image
  input, token estimation, and compatible encrypted reasoning items.
- Add per-profile reasoning effort configuration and a session-runtime
  `/reasoning` control. The TUI displays the active effort, and `Ctrl+R` cycles
  through supported efforts in profile order without changing configuration or
  canonical history.
- Add a model provider configuration guide with ready-to-adapt examples for
  OpenAI, Kimi K3, and Zhipu GLM-5.2.

### Changed

- Split historical session retrieval into `RecallSearch` and `RecallGet`, so the
  agent can locate relevant history before retrieving exact bounded content.
- Track active-turn tool-output consumption when maintaining context, allowing
  already-consumed observations to be compacted safely during long-running
  turns.
- Bound Bash and background-task output previews while preserving complete
  output in log files for paginated inspection.

## [1.9.0] - 2026-08-04

### Added

- Add an UpdatePlan tool that lets the agent maintain a visible, ordered task
  plan for multi-phase work, rendered as a plan view in the TUI timeline and
  printed by the one-shot CLI. Plans are validated (at most 12 steps, at most
  one step in progress), persisted in canonical session history, and fully
  restored when resuming a session.

### Changed

- Trim the runtime system prompt to keep core tool-usage guidance compact.

## [1.8.0] - 2026-08-02

### Added

- Add `tinker update` for manually upgrading a direct npm global installation to
  the latest stable release from the official npm registry.

### Fixed

- Wait for completed background-task output to finish flushing before returning
  it through `TaskOutput`.

## [1.7.0] - 2026-08-01

### Added

- Run interactive terminal programs through PTY-backed Bash tasks, send exact
  keystrokes with `TaskInput`, and inspect their current terminal screen with
  `TaskOutput`.
- Search all resumable sessions from the `/resume` picker by text from their
  first user prompt, including older sessions beyond the 20 most recent.

### Changed

- Keep the live background-task panel compact by showing at most two tasks and
  label PTY-backed tasks explicitly.

### Fixed

- Complete PTY tasks reliably after subprocess exit on Linux, including the EIO
  signal reported when the terminal closes.

## [1.6.0] - 2026-08-01

### Added

- Add an `/undo` slash command that restores the files changed by the most recent
  file-mutation turn from in-memory snapshots, with restore notices shown in the
  TUI timeline.
- Give the agent a Delete tool for removing files, guarded by the same permission
  flow as the other file-mutation tools.
- Guard destructive Bash commands behind an interactive confirmation prompt, with
  a `/yolo` opt-out for sessions where unattended execution is intended.
- Show the latest provider cache hit rate in the TUI prompt status line.
- Stream assistant output in the TUI as sealed Markdown sections, so settled
  content no longer repaints while the turn is still running.

### Changed

- Retry transient provider failures automatically with backoff instead of
  surfacing them as immediate turn errors.
- Update runtime dependencies, including `commander` 15, `openai` 7, and the
  latest `@assistant-ui/react-ink` packages.

### Fixed

- Floor the displayed cache hit rate so append-heavy turns never show a false
  100%.
- Bound the TUI live region below the viewport height to protect the prompt
  frame from being pushed out of view.

## [1.5.1] - 2026-07-29

### Changed

- Keep settled TUI history outside recurring live renders and reuse prepared
  Markdown highlighting, reducing redraw work during long interactive sessions.
- Stop repainting the TUI once per second solely to update a running elapsed-time
  counter; completed turns still show their final duration.

### Fixed

- Restore the visible history tail after closing `/view`, `/memory`, `/resume`,
  and other temporary TUI panels instead of leaving a mostly blank viewport.
- Keep the `/resume` picker bound to the session that opened it, preventing stale
  picker state from affecting a newly activated session.

## [1.5.0] - 2026-07-27

### Added

- Add optional global Memory for the interactive TUI. When configured, Tinker
  extracts durable facts from completed turns, stores them locally, and exposes
  relevant memories to the agent through `MemorySearch`.
- Add a read-only `/memory` browser for reviewing the memories stored in the
  current global Memory database.
- Show live elapsed time in the TUI footer while a turn is running.

### Changed

- Compact and retire context toward 30% input utilization instead of 60%, leaving
  more headroom for continued work after automatic or manual maintenance.

### Fixed

- Let the Tinker Chrome MCP server exit promptly when its client closes stdin,
  avoiding the shutdown timeout during ordinary CLI exit.

## [1.4.0] - 2026-07-24

### Added

- Add stable `tinker --help`, `tinker --version`, and `tinker help run` command
  surfaces with explicit usage errors and exit codes.
- Let one-shot runs read an exact Prompt from explicit stdin or a UTF-8 text file,
  with bounded input and strict encoding validation.

### Changed

- Require `tinker run` to receive exactly one shell-quoted Prompt argument,
  `--stdin`, or `--file <path>`. The former unquoted variadic form is no longer
  joined automatically; quote a short Prompt or use stdin/file input instead.

## [1.3.0] - 2026-07-22

### Added

- Recover automatically when an OpenAI-compatible provider completes a response
  with reasoning only and no final answer or tool call: Tinker retries that exact
  request once without adding the invalid response to session history.

## [1.2.1] - 2026-07-22

### Fixed

- Ignore unrecognized top-level Agent Skill frontmatter fields while continuing to
  validate Tinker's supported fields, so harmless extensions such as `version` no
  longer prevent the CLI from starting. Unknown fields remain available in the
  original `SKILL.md` content when the skill is activated.

## [1.2.0] - 2026-07-21

### Added

- Ship Bun 1.3.14 as an npm dependency and launch it through the installed `tinker`
  command, so users no longer need a system-wide Bun installation.
- Ship a verified platform-specific ripgrep binary for Grep and workspace file
  discovery instead of requiring a system-wide `rg` installation.
- License the project under Apache License 2.0 and preserve the original Infinite
  Context architecture attribution in `NOTICE`.
- Add CI, release-package verification, community health files, and an npm trusted
  publishing workflow with provenance.

### Changed

- Require Node.js 20 or later for the npm-installed launcher.
- Limit npm package contents to runtime source, license and attribution material,
  and required bundled dependencies.

## [1.1.0] - 2026-07-21

### Added

- First formal npm release under the `tinker-agent` package name with the `tinker`
  executable.

[Unreleased]: https://github.com/ishowshao/tinker/compare/v1.10.0...HEAD
[1.10.0]: https://github.com/ishowshao/tinker/releases/tag/v1.10.0
[1.9.0]: https://github.com/ishowshao/tinker/releases/tag/v1.9.0
[1.8.0]: https://github.com/ishowshao/tinker/releases/tag/v1.8.0
[1.7.0]: https://github.com/ishowshao/tinker/releases/tag/v1.7.0
[1.6.0]: https://github.com/ishowshao/tinker/releases/tag/v1.6.0
[1.5.1]: https://github.com/ishowshao/tinker/releases/tag/v1.5.1
[1.5.0]: https://github.com/ishowshao/tinker/releases/tag/v1.5.0
[1.4.0]: https://github.com/ishowshao/tinker/releases/tag/v1.4.0
[1.3.0]: https://github.com/ishowshao/tinker/releases/tag/v1.3.0
[1.2.1]: https://github.com/ishowshao/tinker/releases/tag/v1.2.1
[1.2.0]: https://github.com/ishowshao/tinker/releases/tag/v1.2.0
[1.1.0]: https://www.npmjs.com/package/tinker-agent/v/1.1.0
