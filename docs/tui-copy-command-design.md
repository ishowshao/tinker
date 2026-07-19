# TUI `/copy` Command

## Goal

Tinker TUI provides a built-in `/copy` command that copies the current
session's most recent completed assistant response to the system clipboard as
raw Markdown.

This is a local TUI feature. It does not submit an agent turn, append prompt
history, emit an agent event, modify the session, or change the one-shot
`tinker run` command.

## Command Contract

`/copy` accepts no arguments. Any argument fails with `Usage: /copy`.

The copied value is the canonical `content` of the final assistant message for
the highest-numbered completed turn in the current session. A later failed,
cancelled, or interrupted turn has no final response and therefore does not
replace the last copyable response.

The Markdown is copied exactly as stored. Tinker does not trim it, append a
newline, render it to terminal text, or include reasoning, tool progress,
timeline labels, or status output. A null, empty, or whitespace-only final
content is not copyable.

If no response is available, the TUI reports:

```text
No assistant response is available to copy.
```

After a successful clipboard write, the TUI reports:

```text
Copied last response as Markdown.
```

Reader or clipboard failures report `Copy failed: <reason>`. There is no
fallback to a bounded TUI projection or terminal escape sequence.

## Canonical Source

The live TUI projection carries `finalText`, but resume reconstruction bounds
assistant timeline text to 4,000 characters. Projection state is therefore a
presentation cache, not a complete source for clipboard content.

The reader opens the current session SQLite database read-only and selects the
latest completed turn together with the message referenced by
`turns.final_message_id`. It validates:

- the session schema and workspace/session identity;
- the completed turn has a final message;
- the message belongs to the same session and turn;
- the message role is `assistant` and it has no tool calls;
- the stored content hash matches the canonical content.

Missing or inconsistent canonical data fails close. It is never replaced with
truncated timeline text.

## TUI Flow

The command is registered with the existing built-in slash commands and is
handled by `App` before ordinary prompt submission:

```text
/copy
  -> read canonical last response from SessionStore
  -> write the unmodified string to the system clipboard
  -> show a local TUI notice
```

The reader and clipboard writer are injectable `App` dependencies so component
tests do not open a real session database or alter the developer's clipboard.
While the asynchronous copy operation is active, prompt input is disabled.
This prevents `/clear`, `/resume`, or a new turn from changing the active
session between the read and clipboard write.

The production clipboard adapter uses `clipboardy`. Platform or desktop-session
failures surface to the TUI instead of invoking a second implementation.

## Validation

Tests cover:

- exact command parsing and argument rejection;
- exact Markdown preservation, including code fences and trailing whitespace;
- no-response and clipboard-failure notices;
- proof that `/copy` does not execute an agent turn;
- canonical reads after a later failed or cancelled turn;
- complete reads of responses longer than the resume projection limit;
- resumed-session behavior through the same canonical reader.

The implementation gate is `bun run check`, followed by a local TUI clipboard
smoke test.
