import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PUBLIC_TOOLING_CONFIG } from "../cli/public-config-contract";
import type { GrepOutputMode } from "../tools/types";
import { createDefaultTooling } from "./helpers/tools-support";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";

isolateTinkerHome();

describe("Grep directory search", () => {
  test.each([
    "files_with_matches",
    "content",
    "count",
    "count-matches",
  ] as GrepOutputMode[])("%s anchors globs to the search directory and restores paginated paths", async (mode) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tinker-grep-directory-"));
    const workspace = path.join(root, "workspace");
    const project = path.join(workspace, "project");
    const outside = path.join(root, "outside");
    const parentCwd = process.cwd();
    try {
      for (const directory of [project, outside]) {
        for (const file of ["sub/a.ts", "sub/deep/b.ts", "other/sub/noise.ts"]) {
          await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
          await writeFile(path.join(directory, file), "TARGET\nTARGET\n");
        }
      }
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      tooling.bashState.cwd = project;
      await Promise.all(
        [undefined, "project", outside].map(async (searchPath) => {
          const external = searchPath === outside;
          const expectedPaths = ["sub/a.ts", "sub/deep/b.ts"].map((file) =>
            path.join(external ? outside : "project", file),
          );
          const args = {
            pattern: "TARGET",
            glob: "sub/**",
            output_mode: mode,
            ...(searchPath === undefined ? {} : { path: searchPath }),
          };
          const raw = await tooling.runtime.execute({ name: "Grep", args });
          if (raw.kind !== "grep") throw new Error("Expected Grep result");
          expect(raw).toMatchObject({
            ok: true,
            searchPath: external ? outside : "project",
            absoluteSearchPath: external ? outside : project,
            filenames: expectedPaths,
            numFiles: 2,
            totalResults: mode === "content" ? 4 : 2,
          });
          if (mode === "content") {
            expect(raw.content).toBe(
              expectedPaths
                .flatMap((file) => [`${file}:1:TARGET`, `${file}:2:TARGET`])
                .join("\n"),
            );
          } else if (mode === "count" || mode === "count-matches") {
            expect(raw.counts).toEqual(
              expectedPaths.map((filePath) => ({ filePath, count: 2 })),
            );
            expect(raw.numMatches).toBe(4);
          }
          const page = await tooling.runtime.execute({
            name: "Grep",
            args: { ...args, head_limit: 1, offset: mode === "content" ? 2 : 1 },
          });
          expect(page).toMatchObject({
            ok: true,
            filenames: [expectedPaths[1]],
            numFiles: 1,
          });
        }),
      );
      expect(process.cwd()).toBe(parentCwd);
      expect(tooling.bashState.cwd).toBe(project);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves the search cwd on retry and resolves a relative executable before spawning", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tinker-grep-retry-"));
    const workspace = path.join(root, "workspace");
    const executable = path.join(root, "fake-rg");
    try {
      await mkdir(path.join(workspace, "sub"), { recursive: true });
      await writeFile(path.join(workspace, "sub/helper.ts"), "TARGET\n");
      await writeFile(
        executable,
        [
          "#!/bin/sh",
          '[ -f sub/helper.ts ] || { printf "wrong cwd\\n" >&2; exit 2; }',
          'if [ "$1" != "-j" ]; then printf "EAGAIN\\n" >&2; exit 2; fi',
          "printf './sub/helper.ts\\000'",
          "",
        ].join("\n"),
      );
      await chmod(executable, 0o755);
      const tooling = createDefaultTooling({
        workspaceRoot: workspace,
        toolingConfig: {
          ...DEFAULT_PUBLIC_TOOLING_CONFIG,
          ripgrepPath: path.relative(process.cwd(), executable),
        },
      });
      const raw = await tooling.runtime.execute({
        name: "Grep",
        args: { pattern: "TARGET", glob: "sub/**" },
      });
      expect(raw).toMatchObject({ ok: true, filenames: ["sub/helper.ts"] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
