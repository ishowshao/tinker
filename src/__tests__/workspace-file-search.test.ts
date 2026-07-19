import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { listWorkspaceFiles } from "../tui/workspace-file-search";

describe("workspace file search", () => {
  test("lists workspace files while honoring ignores and explicit exclusions", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-file-search-"));

    try {
      await mkdir(path.join(workspace, ".git"));
      await mkdir(path.join(workspace, ".hidden"));
      await mkdir(path.join(workspace, ".tinker"));
      await mkdir(path.join(workspace, "node_modules", "dependency"), {
        recursive: true,
      });
      await mkdir(path.join(workspace, "src", "node_modules"), {
        recursive: true,
      });

      await writeFile(path.join(workspace, ".gitignore"), "ignored.txt\n");
      await writeFile(path.join(workspace, "README.md"), "readme\n");
      await writeFile(path.join(workspace, " leading-space.txt"), "space\n");
      await writeFile(path.join(workspace, ".hidden", "config.ts"), "hidden\n");
      await writeFile(path.join(workspace, ".git", "config"), "git\n");
      await writeFile(path.join(workspace, ".tinker", "events.jsonl"), "{}\n");
      await writeFile(path.join(workspace, "ignored.txt"), "ignored\n");
      await writeFile(
        path.join(workspace, "node_modules", "dependency", "index.js"),
        "dependency\n",
      );
      await writeFile(
        path.join(workspace, "src", "node_modules", "nested.js"),
        "nested dependency\n",
      );
      await writeFile(path.join(workspace, "src", "index.ts"), "source\n");

      const files = await listWorkspaceFiles(workspace, new AbortController().signal);

      expect([...files].sort()).toEqual(
        [
          " leading-space.txt",
          ".gitignore",
          ".hidden/config.ts",
          "README.md",
          "src/index.ts",
        ].sort(),
      );
    } finally {
      await rm(workspace, { recursive: true });
    }
  });
});
