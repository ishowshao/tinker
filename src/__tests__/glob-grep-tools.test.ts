import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PUBLIC_TOOLING_CONFIG } from "../cli/public-config-contract";
import { ObservationBuilder } from "../observation/observation-builder";
import { createDefaultTooling } from "./helpers/tools-support";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";

isolateTinkerHome();

describe("Glob tool", () => {
  test("skips node_modules and .git during traversal but searches them when set as path", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-glob-"));

    try {
      await mkdir(path.join(workspace, "src"), { recursive: true });
      await mkdir(path.join(workspace, "node_modules", "pkg"), {
        recursive: true,
      });
      await mkdir(path.join(workspace, ".git"), { recursive: true });
      await writeFile(path.join(workspace, "src", "app.ts"), "", "utf8");
      await writeFile(path.join(workspace, ".env.example"), "", "utf8");
      await writeFile(
        path.join(workspace, "node_modules", "pkg", "ignored.ts"),
        "",
        "utf8",
      );
      await writeFile(path.join(workspace, ".git", "config"), "", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Glob",
        args: { pattern: "**/*" },
      });

      expect(raw.ok).toBe(true);
      const matches = "matches" in raw ? (raw.matches ?? []) : [];
      expect(matches).toContain(".env.example");
      expect(matches).toContain("src/app.ts");
      expect(matches).not.toContain("node_modules/pkg/ignored.ts");
      expect(matches).not.toContain(".git/config");

      for (const [directory, file] of [
        ["node_modules", "node_modules/pkg/ignored.ts"],
        [".git", ".git/config"],
      ]) {
        const direct = await tooling.runtime.execute({
          providerToolCallId: `direct_${directory}`,
          name: "Glob",
          args: { pattern: "**/*", path: directory },
        });
        expect(direct).toMatchObject({
          ok: true,
          matches: [file],
          totalMatches: 1,
        });
      }
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("uses optional path as the search directory", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-glob-"));

    try {
      await mkdir(path.join(workspace, "src"), { recursive: true });
      await mkdir(path.join(workspace, "docs"), { recursive: true });
      await writeFile(path.join(workspace, "src", "app.ts"), "", "utf8");
      await writeFile(path.join(workspace, "docs", "guide.ts"), "", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Glob",
        args: { pattern: "*.ts", path: "src" },
      });

      expect(raw.ok).toBe(true);
      expect("searchPath" in raw ? raw.searchPath : "").toBe("src");
      expect("matches" in raw ? raw.matches : []).toEqual(["src/app.ts"]);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("searches an absolute directory outside the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tinker-glob-"));
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    const filePath = path.join(outside, "app.ts");

    try {
      await mkdir(workspace);
      await mkdir(outside);
      await writeFile(filePath, "", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Glob",
        args: { pattern: "*.ts", path: outside },
      });

      expect(raw.ok).toBe(true);
      expect("searchPath" in raw ? raw.searchPath : "").toBe(outside);
      expect("matches" in raw ? raw.matches : []).toEqual([filePath]);
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test("rejects Glob path escape", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-glob-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Glob",
        args: { pattern: "**/*.ts", path: "../outside" },
      });

      expect(raw.ok).toBe(false);
      expect("error" in raw ? raw.error : "").toContain("escapes workspace");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("renders model-visible Glob observation as a path list", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-glob-"));

    try {
      await mkdir(path.join(workspace, "src"), { recursive: true });
      await writeFile(path.join(workspace, "src", "app.ts"), "", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const call = tooling.testRuntime.toolCall({
        providerToolCallId: "call_1",
        name: "Glob",
        args: { pattern: "**/*.ts" },
      });
      const raw = await tooling.runtime.execute(call);
      const observation = new ObservationBuilder().build({ call, raw });

      expect(observation.displayText).toContain(
        'Glob succeeded for pattern="**/*.ts".',
      );
      expect(observation.displayText).toContain("searchPath=.");
      expect(observation.displayText).toContain("ignored=node_modules,.git");
      expect(observation.displayText).toContain("matches:\nsrc/app.ts");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });
});

describe("Grep tool", () => {
  async function withGrepWorkspace(
    callback: (workspace: string) => Promise<void>,
  ): Promise<void> {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-grep-"));

    try {
      await callback(workspace);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  test("registry exposes the Grep schema", async () => {
    await withGrepWorkspace(async (workspace) => {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const definition = tooling.registry
        .definitions()
        .find((tool) => tool.name === "Grep");

      expect(definition).toBeDefined();
      expect(definition?.parameters.additionalProperties).toBe(false);
      expect(definition?.parameters.required).toEqual(["pattern"]);
    });
  });

  test("defaults to files_with_matches with workspace-relative paths", async () => {
    await withGrepWorkspace(async (workspace) => {
      await mkdir(path.join(workspace, "src"), { recursive: true });
      await writeFile(path.join(workspace, "src", "a.ts"), "foo()\n", "utf8");
      await writeFile(path.join(workspace, "src", "b.ts"), "foo()\n", "utf8");
      await writeFile(path.join(workspace, "src", "c.ts"), "bar()\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo" },
      });

      expect(raw.ok).toBe(true);
      expect("mode" in raw ? raw.mode : "").toBe("files_with_matches");
      expect("filenames" in raw ? raw.filenames : []).toEqual(["src/a.ts", "src/b.ts"]);
      expect("numFiles" in raw ? raw.numFiles : 0).toBe(2);
    });
  });

  test("content mode returns matching lines with line numbers", async () => {
    await withGrepWorkspace(async (workspace) => {
      await mkdir(path.join(workspace, "src"), { recursive: true });
      await writeFile(path.join(workspace, "src", "a.ts"), "alpha\nfoo()\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo", output_mode: "content" },
      });

      expect(raw.ok).toBe(true);
      expect("content" in raw ? raw.content : "").toBe("src/a.ts:2:foo()");
      expect("numLines" in raw ? raw.numLines : 0).toBe(1);
    });
  });

  test("content mode supports context lines", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.txt"), "alpha\nfoo\ngamma\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo", output_mode: "content", "-C": 1 },
      });

      expect(raw.ok).toBe(true);
      const content = "content" in raw ? (raw.content ?? "") : "";
      expect(content).toContain("a.txt-1-alpha");
      expect(content).toContain("a.txt:2:foo");
      expect(content).toContain("a.txt-3-gamma");
    });
  });

  test("count mode returns per-file matching line counts and their sum", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.ts"), "foo\nfoo\n", "utf8");
      await writeFile(path.join(workspace, "b.ts"), "foo\nfoo\nfoo\nbar\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo", output_mode: "count" },
      });

      expect(raw.ok).toBe(true);
      expect("content" in raw ? raw.content : "").toBe("a.ts:2\nb.ts:3");
      expect("numMatches" in raw ? raw.numMatches : 0).toBe(5);
      expect("numFiles" in raw ? raw.numFiles : 0).toBe(2);
    });
  });

  test("applies head_limit and offset pagination", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.ts"), "foo\n", "utf8");
      await writeFile(path.join(workspace, "b.ts"), "foo\n", "utf8");
      await writeFile(path.join(workspace, "c.ts"), "foo\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const firstPage = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo", head_limit: 2 },
      });

      expect(firstPage.ok).toBe(true);
      expect("filenames" in firstPage ? firstPage.filenames : []).toEqual([
        "a.ts",
        "b.ts",
      ]);
      expect("appliedLimit" in firstPage ? firstPage.appliedLimit : undefined).toBe(2);
      expect("truncated" in firstPage ? firstPage.truncated : undefined).toBe(true);

      const secondPage = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Grep",
        args: { pattern: "foo", head_limit: 2, offset: 2 },
      });

      expect(secondPage.ok).toBe(true);
      expect("filenames" in secondPage ? secondPage.filenames : []).toEqual(["c.ts"]);
      expect(
        "appliedLimit" in secondPage ? secondPage.appliedLimit : undefined,
      ).toBeUndefined();
      expect("appliedOffset" in secondPage ? secondPage.appliedOffset : undefined).toBe(
        2,
      );
    });
  });

  test("filters by glob and type", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.ts"), "foo\n", "utf8");
      await writeFile(path.join(workspace, "b.js"), "foo\n", "utf8");
      await writeFile(path.join(workspace, "c.md"), "foo\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const globFiltered = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo", glob: "*.ts" },
      });
      expect("filenames" in globFiltered ? globFiltered.filenames : []).toEqual([
        "a.ts",
      ]);

      const typeFiltered = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Grep",
        args: { pattern: "foo", type: "js" },
      });
      expect("filenames" in typeFiltered ? typeFiltered.filenames : []).toEqual([
        "b.js",
      ]);
    });
  });

  test("preserves brace expansion in glob filters", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.ts"), "foo\n", "utf8");
      await writeFile(path.join(workspace, "b.tsx"), "foo\n", "utf8");
      await writeFile(path.join(workspace, "c.js"), "foo\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo", glob: "**/*.{ts,tsx}" },
      });

      expect(raw.ok).toBe(true);
      expect("filenames" in raw ? raw.filenames : []).toEqual(["a.ts", "b.tsx"]);
    });
  });

  test("supports case-insensitive and multiline search", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.ts"), "FOO\nbar\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const caseSensitive = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo" },
      });
      expect("numFiles" in caseSensitive ? caseSensitive.numFiles : -1).toBe(0);

      const caseInsensitive = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Grep",
        args: { pattern: "foo", "-i": true },
      });
      expect("filenames" in caseInsensitive ? caseInsensitive.filenames : []).toEqual([
        "a.ts",
      ]);

      const withoutMultiline = await tooling.runtime.execute({
        providerToolCallId: "call_3",
        name: "Grep",
        args: { pattern: "FOO.bar" },
      });
      expect("numFiles" in withoutMultiline ? withoutMultiline.numFiles : -1).toBe(0);

      const multiline = await tooling.runtime.execute({
        providerToolCallId: "call_4",
        name: "Grep",
        args: { pattern: "FOO.bar", multiline: true },
      });
      expect("filenames" in multiline ? multiline.filenames : []).toEqual(["a.ts"]);
    });
  });

  test("searches patterns that start with a dash", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.sh"), "run --verbose\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "--verbose" },
      });

      expect(raw.ok).toBe(true);
      expect("filenames" in raw ? raw.filenames : []).toEqual(["a.sh"]);
    });
  });

  test("returns ok with empty results when nothing matches", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.ts"), "alpha\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "missing" },
      });

      expect(raw.ok).toBe(true);
      expect("filenames" in raw ? raw.filenames : ["x"]).toEqual([]);
      expect("numFiles" in raw ? raw.numFiles : -1).toBe(0);
    });
  });

  test("supports searching a single file path", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.ts"), "foo\n", "utf8");
      await writeFile(path.join(workspace, "b.ts"), "foo\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo", path: "a.ts", output_mode: "content" },
      });

      expect(raw.ok).toBe(true);
      expect("content" in raw ? raw.content : "").toBe("a.ts:1:foo");
    });
  });

  test("searches an absolute file path outside the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tinker-grep-"));
    const workspace = path.join(root, "workspace");
    const filePath = path.join(root, "outside.ts");

    try {
      await mkdir(workspace);
      await writeFile(filePath, "foo\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo", path: filePath, output_mode: "content" },
      });

      expect(raw.ok).toBe(true);
      expect("searchPath" in raw ? raw.searchPath : "").toBe(filePath);
      expect("content" in raw ? raw.content : "").toBe(`${filePath}:1:foo`);
      expect("filenames" in raw ? raw.filenames : []).toEqual([filePath]);
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test("rejects path escape and missing paths", async () => {
    await withGrepWorkspace(async (workspace) => {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      const escape = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo", path: "../outside" },
      });
      expect(escape.ok).toBe(false);
      expect("error" in escape ? escape.error : "").toContain("escapes workspace");

      const missing = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Grep",
        args: { pattern: "foo", path: "does-not-exist" },
      });
      expect(missing.ok).toBe(false);
      expect("error" in missing ? missing.error : "").toContain("does not exist");
    });
  });

  test("ignores node_modules, .git, and .tinker by default", async () => {
    await withGrepWorkspace(async (workspace) => {
      await mkdir(path.join(workspace, "node_modules", "pkg"), { recursive: true });
      await mkdir(path.join(workspace, ".git"), { recursive: true });
      await mkdir(path.join(workspace, ".tinker"), { recursive: true });
      await writeFile(path.join(workspace, "a.ts"), "foo\n", "utf8");
      await writeFile(
        path.join(workspace, "node_modules", "pkg", "b.ts"),
        "foo\n",
        "utf8",
      );
      await writeFile(path.join(workspace, ".git", "config"), "foo\n", "utf8");
      await writeFile(path.join(workspace, ".tinker", "log.md"), "foo\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo" },
      });

      expect(raw.ok).toBe(true);
      expect("filenames" in raw ? raw.filenames : []).toEqual(["a.ts"]);
    });
  });

  test("fails with a clear error when ripgrep is missing", async () => {
    await withGrepWorkspace(async (workspace) => {
      const tooling = createDefaultTooling({
        workspaceRoot: workspace,
        toolingConfig: {
          ...DEFAULT_PUBLIC_TOOLING_CONFIG,
          ripgrepPath: path.join(workspace, "missing-rg"),
        },
      });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo" },
      });

      expect(raw.ok).toBe(false);
      expect("error" in raw ? raw.error : "").toBe(
        "Tinker's bundled ripgrep executable is unavailable. Reinstall tinker-agent.",
      );
    });
  });

  test("renders files_with_matches observations", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.ts"), "foo\n", "utf8");
      await writeFile(path.join(workspace, "b.ts"), "foo\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const call = tooling.testRuntime.toolCall({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo" },
      });
      const raw = await tooling.runtime.execute(call);
      const observation = new ObservationBuilder().build({ call, raw });

      expect(observation.displayText).toBe("Found 2 matching files\na.ts\nb.ts");

      const emptyCall = tooling.testRuntime.toolCall({
        providerToolCallId: "call_2",
        name: "Grep",
        args: { pattern: "missing" },
      });
      const emptyRaw = await tooling.runtime.execute(emptyCall);
      const emptyObservation = new ObservationBuilder().build({
        call: emptyCall,
        raw: emptyRaw,
      });

      expect(emptyObservation.displayText).toBe("No matches found");
    });
  });

  test("renders content and count observations", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.ts"), "foo\n", "utf8");
      await writeFile(path.join(workspace, "b.ts"), "foo\nfoo\nfoo\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const contentCall = tooling.testRuntime.toolCall({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo", path: "a.ts", output_mode: "content" },
      });
      const contentRaw = await tooling.runtime.execute(contentCall);
      const contentObservation = new ObservationBuilder().build({
        call: contentCall,
        raw: contentRaw,
      });
      expect(contentObservation.displayText).toBe("a.ts:1:foo");

      const noMatchCall = tooling.testRuntime.toolCall({
        providerToolCallId: "call_2",
        name: "Grep",
        args: { pattern: "missing", output_mode: "content" },
      });
      const noMatchRaw = await tooling.runtime.execute(noMatchCall);
      const noMatchObservation = new ObservationBuilder().build({
        call: noMatchCall,
        raw: noMatchRaw,
      });
      expect(noMatchObservation.displayText).toBe("No matches found");

      const countCall = tooling.testRuntime.toolCall({
        providerToolCallId: "call_3",
        name: "Grep",
        args: { pattern: "foo", output_mode: "count" },
      });
      const countRaw = await tooling.runtime.execute(countCall);
      const countObservation = new ObservationBuilder().build({
        call: countCall,
        raw: countRaw,
      });
      expect(countObservation.displayText).toBe(
        "a.ts: 1 matching line\nb.ts: 3 matching lines\n\nTotal: 4 matching lines across 2 matching files.",
      );
    });
  });

  test("renders pagination info in observations", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.ts"), "foo\n", "utf8");
      await writeFile(path.join(workspace, "b.ts"), "foo\n", "utf8");
      await writeFile(path.join(workspace, "c.ts"), "foo\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const call = tooling.testRuntime.toolCall({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo", head_limit: 1, offset: 1 },
      });
      const raw = await tooling.runtime.execute(call);
      const observation = new ObservationBuilder().build({ call, raw });

      expect(observation.displayText).toContain(
        "Showing 1 matching file on this page\nb.ts",
      );
      expect(observation.displayText).toContain(
        "More results available; nextOffset=2.",
      );
    });
  });

  test("renders failure observations with the pattern", async () => {
    await withGrepWorkspace(async (workspace) => {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const call = tooling.testRuntime.toolCall({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo", path: "../outside" },
      });
      const raw = await tooling.runtime.execute(call);
      const observation = new ObservationBuilder().build({ call, raw });

      expect(observation.displayText).toBe(
        'Grep failed for pattern="foo": Path escapes workspace.',
      );
    });
  });
});
