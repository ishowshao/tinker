# Repository Guidelines

## Project Structure & Module Organization

This is a Bun-powered TypeScript ESM CLI project. Source lives under `src/`.
Key areas include `src/cli` for command entry points, `src/agent` for loop
orchestration, `src/tools` for tool implementations, `src/model` for model
adapters, `src/events` for event sinks and logs, `src/tui` for Ink/React UI,
and `src/observation` for observation formatting. Tests are colocated in
`src/__tests__/*.test.ts` and `*.test.tsx`. Planning and design notes live in
`docs/`.

## Build, Test, and Development Commands

- `bun install`: install dependencies from `bun.lock`.
- `bun run tinker`: start the default interactive TUI.
- `bun run tinker run "prompt"`: run a one-shot CLI prompt.
- `bun test`: run the Bun test suite.
- `bun run typecheck`: run `tsc --noEmit` with strict TypeScript settings.
- `bun run lint`: run ESLint on `src/**/*.{ts,tsx}` with zero warnings.
- `bun run format:check`: check Biome formatting.
- `bun run format`: apply Biome formatting.
- `bun run check`: run typecheck, format check, lint, and tests.

## Coding Style & Naming Conventions

Use strict TypeScript and prefer fast-fail code: validate assumptions early and
return clear errors close to the source. Biome formats with 2-space indentation,
88-column lines, double quotes, semicolons, and trailing commas in JavaScript and
TypeScript. Keep file names in kebab case, such as `run-runner.ts`; use
PascalCase for classes and types, and camelCase for functions and variables.

## Testing Guidelines

Use `bun:test` for unit tests. Name new tests after the behavior under test and
place them in `src/__tests__/` with the existing `*.test.ts` or `*.test.tsx`
pattern. For TUI behavior, use `ink-testing-library`. Prefer focused tests that
exercise public module behavior, and use temporary directories for filesystem
tests so repository files are not mutated.
