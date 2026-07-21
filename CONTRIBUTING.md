# Contributing to Tinker

Thank you for helping improve Tinker.

## Development setup

Tinker requires Bun 1.3 or later.

```bash
git clone https://github.com/ishowshao/tinker.git
cd tinker
bun install --frozen-lockfile
bun run check
```

Use `bun run tinker` for the interactive TUI and
`bun run tinker run "prompt"` for one-shot execution.

## Proposing changes

- Open an issue before investing in a large feature or externally visible contract
  change.
- Keep pull requests focused and explain the user-visible behavior they change.
- Add focused `bun:test` coverage for behavior changes.
- Preserve fast-fail semantics: reject invalid state close to its source instead of
  adding silent fallbacks.
- Run `bun run check` before submitting a pull request.

By submitting a contribution, you agree that it is licensed under the Apache License
2.0 that covers this repository.
