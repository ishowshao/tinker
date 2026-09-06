import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ObservationBuilder } from "../observation/observation-builder";
import { decodeStoredToolRawResult } from "../session/session-tool-result-codec";
import { findRipgrepCommand } from "../tools/ripgrep";
import { createDefaultTooling } from "./helpers/tools-support";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";
import { createTestRuntime } from "./test-runtime";

isolateTinkerHome();

describe("Grep ripgrep wrapper", () => {
  test("regex errors retain native diagnostics without the unsupported PCRE2 suggestion", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-grep-errors-"));
    try {
      await writeFile(path.join(workspace, "a.txt"), "needle red\n");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      for (const pattern of ["needle(?= red)", "(needle)\\1", "["]) {
        const native = Bun.spawnSync(
          [findRipgrepCommand(), "--no-config", "-e", pattern, "a.txt"],
          { cwd: workspace },
        );
        expect(native.exitCode).toBe(2);
        const stderr = native.stderr.toString().trim();
        const expected = stderr.split("\n\nConsider enabling PCRE2")[0];
        if (pattern === "[") {
          expect(expected).toBe(stderr);
        } else {
          expect(stderr).toContain("Consider enabling PCRE2");
        }
        const call = tooling.testRuntime.toolCall({ name: "Grep", args: { pattern } });
        const raw = await tooling.runtime.execute(call);
        expect(raw).toMatchObject({ ok: false, error: expected });
        const restored = decodeStoredToolRawResult(JSON.parse(JSON.stringify(raw)));
        const observation = new ObservationBuilder().build({ call, raw: restored });
        expect(observation.displayText).toBe(
          `Grep failed for pattern=${JSON.stringify(pattern)}: ${expected}`,
        );
        expect(observation.displayText).not.toContain("--pcre2");
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("matches native rg running in the search directory or given an absolute file", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-grep-wrapper-"));
    try {
      for (const file of [
        "src/main.ts",
        "src/component.tsx",
        "src/main.js",
        "guide.md",
        "node_modules/pkg/main.ts",
        ".git/probe.txt",
        ".tinker/probe.txt",
      ]) {
        await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
        await writeFile(path.join(workspace, file), "needle\n");
      }
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const cases: { path?: string; glob?: string; type?: string }[] = [
        {},
        { glob: "*.ts" },
        { glob: "*.{ts,tsx}" },
        { glob: "src/**/*.ts*" },
        { glob: "**/src/**/*.ts*" },
        { type: "ts", glob: "*.js" },
        { type: "ts", glob: "*.md" },
        { glob: "**/*" },
        { path: "src", glob: "*.ts" },
        { path: workspace, glob: "src/**/*.ts*" },
        { path: "src/main.js", type: "ts", glob: "!*.js" },
      ];
      for (const input of cases) {
        const absoluteSearchPath = path.resolve(workspace, input.path ?? ".");
        const isDirectory = (await stat(absoluteSearchPath)).isDirectory();
        const cwd = isDirectory ? absoluteSearchPath : process.cwd();
        // Independent native invocation: do not reuse the wrapper's argument builder.
        const args = ["--no-config", "--hidden", "--sort", "path", "--color", "never"];
        for (const directory of [
          ".git",
          ".svn",
          ".hg",
          ".bzr",
          ".jj",
          ".sl",
          "node_modules",
          ".tinker",
        ]) {
          args.push("--glob", `!${directory}`);
        }
        args.push("-l", "--null");
        if (input.type !== undefined) args.push("--type", input.type);
        if (input.glob !== undefined) args.push("--glob", input.glob);
        args.push("-e", "needle", isDirectory ? "." : absoluteSearchPath);
        const native = Bun.spawn([findRipgrepCommand(), ...args], {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          native.exited,
          new Response(native.stdout).text(),
          new Response(native.stderr).text(),
        ]);
        expect([0, 1]).toContain(exitCode);
        expect(stderr).toBe("");
        const filenames = stdout
          .split("\0")
          .filter(Boolean)
          .map((file) => path.relative(workspace, path.resolve(cwd, file)));
        const raw = await tooling.runtime.execute({
          name: "Grep",
          args: { pattern: "needle", ...input },
        });
        expect(raw).toMatchObject({
          ok: true,
          absoluteSearchPath,
          filenames,
          numFiles: filenames.length,
        });
        expect(raw).not.toHaveProperty("ignored");
      }
      const failure = await tooling.runtime.execute({
        name: "Grep",
        args: { pattern: "needle", path: "missing" },
      });
      expect(failure.ok).toBe(false);
      expect(failure).not.toHaveProperty("ignored");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("restores legacy exclusions without treating them as observed skips", () => {
    const stored = {
      kind: "grep" as const,
      ok: true,
      pattern: "needle",
      searchPath: ".",
      mode: "files_with_matches" as const,
      filenames: ["node_modules/pkg/main.ts"],
      numFiles: 1,
      ignored: ["node_modules", ".git"],
    };
    const raw = decodeStoredToolRawResult(JSON.parse(JSON.stringify(stored)));
    expect(raw).toEqual(stored);
    const call = createTestRuntime().toolCall({ name: "Grep", args: {} });
    const observation = new ObservationBuilder().build({ call, raw });
    expect(observation.displayText).toBe(
      "Found 1 matching file\nnode_modules/pkg/main.ts",
    );
  });
});
