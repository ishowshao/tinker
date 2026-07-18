# Project Custom Slash Commands

## Goal

Tinker TUI can load project-scoped slash commands from
`<workspaceRoot>/.tinker.json`. A custom command is a named alias for a normal
user prompt. Selecting or entering the command expands the configured prompt
and submits it through the existing TUI prompt path.

This is a presentation/input feature. The project configuration, command name,
and expansion mechanism do not become part of the agent loop, runtime contract,
context surface, session schema, or event protocol.

## Configuration

`.tinker.json` is a committable project configuration file. It is deliberately
separate from `.tinker/`, which remains ignored runtime data.

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

The command name omits the leading slash. Names must match
`^[a-z0-9][a-z0-9-]{0,63}$`, must be unique, and must not collide with any
built-in slash command. `description` and `prompt` must be non-empty strings.
Unknown fields are rejected.

The file is optional. When present, it must be a regular UTF-8 file no larger
than 1 MiB. A symlink target must remain inside the workspace. Invalid present
configuration fails TUI startup before a runtime session is created; there is
no silent fallback.

The file is loaded once at TUI startup. Changes require a TUI restart. The
one-shot `tinker run` command does not load or interpret project slash commands.

## TUI Semantics

Slash suggestions contain all currently available built-in commands first,
followed by project commands in configuration order. Project commands never
replace or reorder built-ins.

Version 1 custom commands accept no arguments. `/name` expands and submits;
`/name anything` fails with `Usage: /name`.

Expansion calls the ordinary agent-prompt submission function directly. It
must not recursively call the slash-command dispatcher because a configured
prompt may itself begin with `/`.

The expanded prompt, not the alias, is written to prompt history and committed
as the canonical user message. Consequently the timeline, Recall, resume, and
the model all observe exactly the same content they would observe if the user
had pasted and submitted the configured prompt manually. No expansion event or
configuration snapshot is persisted.

## Validation

Tests cover optional-file behavior, bounded and strict UTF-8 loading, schema
validation, duplicate and built-in name conflicts, suggestion ordering, exact
invocation, rejection of arguments, and proof that execution and prompt history
receive only the expanded prompt. Existing built-in command behavior remains
unchanged.
