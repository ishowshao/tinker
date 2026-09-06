import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ObservationBuilder } from "../observation/observation-builder";
import { createDefaultTooling } from "./helpers/tools-support";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";

isolateTinkerHome();

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-glob-types-"));
  try {
    await mkdir(path.join(workspace, "docs"));
    await mkdir(path.join(workspace, "emptydir"));
    await writeFile(path.join(workspace, "docs/README.md"), "fixture");
    await symlink("docs", path.join(workspace, "a-directory-link"));
    await symlink("missing", path.join(workspace, "b-broken-link"));
    await symlink("docs/README.md/child", path.join(workspace, "c-invalid-link"));
    await symlink("docs/README.md", path.join(workspace, "file-link"));
    await symlink("file-link", path.join(workspace, "file-link-chain"));
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

describe("Glob file types", () => {
  test("returns files and file links, excluding directory links and broken links", async () => {
    await withWorkspace(async (workspace) => {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      for (const [pattern, matches] of [
        ["*", ["file-link", "file-link-chain"]],
        ["**/*", ["docs/README.md", "file-link", "file-link-chain"]],
        ["a-directory-link", []],
        ["b-broken-link", []],
        ["c-invalid-link", []],
        ["file-link", ["file-link"]],
      ] as const) {
        const raw = await tooling.runtime.execute({
          providerToolCallId: `types_${pattern}`,
          name: "Glob",
          args: { pattern },
        });
        expect(raw).toMatchObject({
          ok: true,
          matches,
          totalMatches: matches.length,
          returnedCount: matches.length,
          hasMore: false,
        });
      }
    });
  });

  test("preserves explicit traversal through a directory link and optional search paths", async () => {
    await withWorkspace(async (workspace) => {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      for (const args of [
        { pattern: "a-directory-link/*.md" },
        { pattern: "*.md", path: "a-directory-link" },
        { pattern: "*.md", path: path.join(workspace, "a-directory-link") },
      ]) {
        const raw = await tooling.runtime.execute({
          providerToolCallId: "explicit_link",
          name: "Glob",
          args,
        });
        expect(raw).toMatchObject({
          ok: true,
          matches: ["a-directory-link/README.md"],
          totalMatches: 1,
        });
      }
    });
  });

  test("filters before counting and paginating model-visible results", async () => {
    await withWorkspace(async (workspace) => {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const matches = ["docs/README.md", "file-link", "file-link-chain"];
      for (const offset of [0, 1, 2, 3]) {
        const call = tooling.testRuntime.toolCall({
          providerToolCallId: `page_${offset}`,
          name: "Glob",
          args: { pattern: "**/*", head_limit: 1, offset },
        });
        const raw = await tooling.runtime.execute(call);
        const page = matches.slice(offset, offset + 1);
        expect(raw).toMatchObject({
          ok: true,
          matches: page,
          matchCount: page.length,
          totalMatches: 3,
          returnedCount: page.length,
          appliedOffset: offset,
          hasMore: offset < 2,
        });
        if (offset < 2) expect(raw).toHaveProperty("nextOffset", offset + 1);
        else expect(raw).not.toHaveProperty("nextOffset");
        const text = new ObservationBuilder().build({ call, raw }).displayText;
        expect(text).toContain("totalMatches=3");
        expect(text).not.toContain("directory-link");
        expect(text).not.toContain("broken-link");
        expect(text).not.toContain("invalid-link");
      }
    });
  });

  test("reports a link resolution loop as an error rather than an empty success", async () => {
    await withWorkspace(async (workspace) => {
      await symlink("loop", path.join(workspace, "loop"));
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "loop",
        name: "Glob",
        args: { pattern: "loop" },
      });
      expect(raw).toMatchObject({ ok: false });
      expect(raw).toHaveProperty("error", expect.stringContaining("ELOOP"));
    });
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports permission errors while resolving file links",
    async () => {
      await withWorkspace(async (workspace) => {
        const restricted = path.join(workspace, "restricted");
        await mkdir(restricted);
        await writeFile(path.join(restricted, "file"), "fixture");
        await symlink("restricted/file", path.join(workspace, "restricted-link"));
        const tooling = createDefaultTooling({ workspaceRoot: workspace });
        await chmod(restricted, 0);
        try {
          const raw = await tooling.runtime.execute({
            providerToolCallId: "permission",
            name: "Glob",
            args: { pattern: "restricted-link" },
          });
          expect(raw).toMatchObject({ ok: false });
          expect(raw).toHaveProperty("error", expect.stringContaining("EACCES"));
        } finally {
          await chmod(restricted, 0o700);
        }
      });
    },
  );
});
