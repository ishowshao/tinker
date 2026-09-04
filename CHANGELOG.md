# Changelog

All notable user-facing changes to Tinker are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.7.0] - 2026-09-04

### Added

- Add `AskUser`, an interactive tool that lets the agent pause on a material
  ambiguity and present two to six complete choices in the TUI before resuming
  the same turn with the selected answer.
- Add model-accessible `MemoryCreate`, `MemoryUpdate`, and `MemoryDelete` tools
  for explicitly maintaining global memories shared across sessions and
  workspaces.

### Changed

- Redesign the session resume picker as a compact table, making session metadata
  easier to scan while preserving keyboard navigation and search.

### Fixed

- Give the long-history PTY resume fixture enough time on slower Linux CI
  runners, avoiding a false timeout while the model is still producing the
  expected response.

## [2.6.0] - 2026-09-03

### Added

- Show the installed Tinker version at the end of the interactive prompt status
  bar.

### Changed

- Raise the default maximum agent-loop iterations per turn from 512 to 65,536,
  allowing longer autonomous tasks without requiring configuration changes.

### Fixed

- Preserve brace expressions in Grep glob filters, so patterns such as
  `**/*.{ts,tsx}` are passed to ripgrep intact.

## [2.5.0] - 2026-09-03

### Added

- Proactively notify the model when input context reaches high or critical
  pressure, prompting it to review and swap evictable historical tool
  observations while keeping swapped content recoverable through Recall. The
  runtime gives the model one iteration to act before automatic compaction
  resumes, while critical pressure still triggers immediate maintenance.

## [2.4.0] - 2026-09-02

### Added

- Add model-directed context management. Three new built-in tools open context
  maintenance to the model itself: `ContextStatus` reports live input-token
  usage and pressure, `ContextSwapCandidates` lists swappable historical tool
  observations with short labels and byte savings, and `ContextSwap` schedules
  selected observations for eviction. Scheduled swaps are validated immediately
  and committed as one context revision when the iteration's tool frames close,
  leaving Recall-recoverable placeholders behind. A one-shot lease pauses
  automatic compaction for exactly one iteration after a candidate listing so
  the model keeps the choice under real pressure.

### Changed

- Lower the swap eligibility floor from 8 KiB to 2 KiB per observation. Both
  automatic compaction and model-directed swaps can now evict medium-sized
  tool observations, individually or in batches of up to 16 per swap.

## [2.3.0] - 2026-08-31

### Changed

- Store per-workspace runtime state in the global Tinker home instead of inside
  the project. Sessions (`sessions/<id>/`), background Bash logs (`bash/`),
  image assets (`assets/images/`), and prompt history now live under
  `~/.tinker/projects/<workspace-slug-hash>/`, keyed by the workspace's
  canonical absolute path. Projects no longer grow a `.tinker/` directory.
  Existing in-project `.tinker/` state is left in place but no longer read.
- Add `TINKER_HOME` to relocate the global Tinker home directory (default: the
  OS home directory).

## [2.2.0] - 2026-08-29

### Added

- Log raw vector cosine scores in `MemorySearch` diagnostics, making hybrid
  recall ranking easier to inspect and tune.

### Changed

- Restyle the prompt-input footer status line with a muted color palette:
  model name, workspace path, Git branch, and cache hit rate each get a soft
  accent color, and normal-pressure context usage now renders in a cool gray
  instead of plain dim. Red and yellow remain reserved for context-pressure
  warnings.

## [2.1.0] - 2026-08-29

### Added

- Add cross-session derived memory. Completed turns are distilled into memory
  records that the agent can recall in later sessions and workspaces through
  `MemorySearch`, which fuses vector similarity with FTS5 keyword matching via
  RRF hybrid ranking, and `MemoryGet`, which reads a full record by its id.
- Add a `toolResultModalities` model-profile setting. Image-capable profiles can
  now receive `ViewImage` results as real image content in the model request
  instead of text-only descriptions.
- Add a `Wait` tool that pauses the agent loop for a cancellable whole number of
  seconds (1 to 3600), useful for spacing polling attempts.
- Expand a leading `~` to the user's home directory in `TINKER_MODELS` and
  `TINKER_WORKSPACE` paths.

### Changed

- Show `MemorySearch` keywords alongside the query in TUI tool summaries, so
  hybrid recall behavior is visible while observing the agent.

### Fixed

- Accept `memory_get` raw results in stored tool history, so sessions that
  contain MemoryGet calls remain resumable.

## [2.0.0] - 2026-08-20

### Changed

- Estimate image input locally with deterministic size buckets instead of a
  provider-side token-estimation request. Images are normalized for orientation
  and provider limits before estimation and upload, keeping preflight accounting
  aligned with the payload sent to the model.

### Removed

- Remove the `tokenEstimator` model-profile setting. Existing image profiles must
  delete that field; sessions created under the previous image policy remain
  inspectable but cannot be resumed for execution.

## [1.11.0] - 2026-08-15

### Added

- Allow text follow-up prompts to be queued while a turn is running. Follow-ups
  are applied safely after a complete tool batch or handed off to a new turn
  after a final response, while preserving canonical session history and TUI
  continuity.

## [1.10.1] - 2026-08-15

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

[Unreleased]: https://github.com/ishowshao/tinker/compare/v2.7.0...HEAD
[2.7.0]: https://github.com/ishowshao/tinker/releases/tag/v2.7.0
[2.6.0]: https://github.com/ishowshao/tinker/releases/tag/v2.6.0
[2.5.0]: https://github.com/ishowshao/tinker/releases/tag/v2.5.0
[2.4.0]: https://github.com/ishowshao/tinker/releases/tag/v2.4.0
[2.3.0]: https://github.com/ishowshao/tinker/releases/tag/v2.3.0
[2.2.0]: https://github.com/ishowshao/tinker/releases/tag/v2.2.0
[2.1.0]: https://github.com/ishowshao/tinker/releases/tag/v2.1.0
[2.0.0]: https://github.com/ishowshao/tinker/releases/tag/v2.0.0
[1.11.0]: https://github.com/ishowshao/tinker/releases/tag/v1.11.0
[1.10.1]: https://github.com/ishowshao/tinker/releases/tag/v1.10.1
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
