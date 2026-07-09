import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ObservationBuilder } from "../observation/observation-builder";
import { createDefaultTooling } from "../tools/registry";

describe("Read and Write tools", () => {
  test("reads a workspace file with metadata", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tools-"));

    try {
      await writeFile(path.join(workspace, "notes.txt"), "a\nb\nc\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        id: "call_1",
        name: "Read",
        args: { file_path: "notes.txt", offset: 2, limit: 1 },
      });

      expect(raw.ok).toBe(true);
      expect("content" in raw ? raw.content : "").toBe("b");
      expect("totalLines" in raw ? raw.totalLines : 0).toBe(3);
      expect("sha256" in raw ? raw.sha256 : undefined).toBeString();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("rejects path escape", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tools-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        id: "call_1",
        name: "Read",
        args: { file_path: "../outside.txt" },
      });

      expect(raw.ok).toBe(false);
      expect("error" in raw ? raw.error : "").toContain("escapes workspace");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("writes a new file", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tools-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        id: "call_1",
        name: "Write",
        args: { file_path: "notes.txt", content: "hello\n" },
      });

      expect(raw.ok).toBe(true);
      expect(await readFile(path.join(workspace, "notes.txt"), "utf8")).toBe("hello\n");
      expect("created" in raw ? raw.created : false).toBe(true);
      const patch = "patch" in raw ? raw.patch : undefined;
      expect(patch?.[0]?.lines).toEqual(["+hello"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("returns a structured patch when overwriting after Read", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tools-"));

    try {
      await writeFile(path.join(workspace, "notes.txt"), "old\nsame\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        id: "call_1",
        name: "Read",
        args: { file_path: "notes.txt" },
      });
      const raw = await tooling.runtime.execute({
        id: "call_2",
        name: "Write",
        args: { file_path: "notes.txt", content: "new\nsame\n" },
      });

      expect(raw.ok).toBe(true);
      expect("created" in raw ? raw.created : true).toBe(false);
      const patch = "patch" in raw ? raw.patch : undefined;
      expect(patch?.[0]?.lines).toEqual(["-old", "+new", " same"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("requires Read before overwriting an existing file", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tools-"));

    try {
      await writeFile(path.join(workspace, "notes.txt"), "old\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        id: "call_1",
        name: "Write",
        args: { file_path: "notes.txt", content: "new\n" },
      });

      expect(raw.ok).toBe(false);
      expect(
        "requiredReadBeforeWrite" in raw ? raw.requiredReadBeforeWrite : false,
      ).toBe(true);
      expect(await readFile(path.join(workspace, "notes.txt"), "utf8")).toBe("old\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("rejects Write when file changed after Read", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tools-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "old\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        id: "call_1",
        name: "Read",
        args: { file_path: "notes.txt" },
      });
      await writeFile(filePath, "external\n", "utf8");

      const raw = await tooling.runtime.execute({
        id: "call_2",
        name: "Write",
        args: { file_path: "notes.txt", content: "new\n" },
      });

      expect(raw.ok).toBe(false);
      expect("error" in raw ? raw.error : "").toContain("changed");
      expect(await readFile(filePath, "utf8")).toBe("external\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("Edit tool", () => {
  test("replaces a single exact string after a complete Read", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        id: "call_1",
        name: "Read",
        args: { file_path: "notes.txt" },
      });
      const raw = await tooling.runtime.execute({
        id: "call_2",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
        },
      });

      expect(raw.ok).toBe(true);
      expect("replacementCount" in raw ? raw.replacementCount : 0).toBe(1);
      const secondRaw = await tooling.runtime.execute({
        id: "call_3",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "gamma",
          new_string: "omega",
        },
      });

      expect(secondRaw.ok).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("alpha\ndelta\nomega\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("returns a structured patch describing the edit", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        id: "call_1",
        name: "Read",
        args: { file_path: "notes.txt" },
      });
      const raw = await tooling.runtime.execute({
        id: "call_2",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
        },
      });

      expect(raw.ok).toBe(true);
      const patch = "patch" in raw ? raw.patch : undefined;
      expect(patch).toHaveLength(1);
      expect(patch?.[0]?.lines).toEqual([" alpha", "-beta", "+delta", " gamma"]);
      expect("patchTruncated" in raw ? raw.patchTruncated : undefined).toBe(false);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("returns an all-additions patch when creating a file", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        id: "call_1",
        name: "Edit",
        args: {
          file_path: "fresh.txt",
          old_string: "",
          new_string: "a\nb\n",
        },
      });

      expect(raw.ok).toBe(true);
      expect("created" in raw ? raw.created : false).toBe(true);
      const patch = "patch" in raw ? raw.patch : undefined;
      expect(patch?.[0]?.lines).toEqual(["+a", "+b"]);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("requires a complete Read before editing", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        id: "call_1",
        name: "Read",
        args: { file_path: "notes.txt", offset: 2, limit: 1 },
      });
      const raw = await tooling.runtime.execute({
        id: "call_2",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
        },
      });

      expect(raw.ok).toBe(false);
      expect("requiredReadBeforeEdit" in raw ? raw.requiredReadBeforeEdit : false).toBe(
        true,
      );
      expect(await readFile(filePath, "utf8")).toBe("alpha\nbeta\ngamma\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("rejects Edit when file mtime is newer than the Read snapshot", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        id: "call_1",
        name: "Read",
        args: { file_path: "notes.txt" },
      });
      await writeFile(filePath, "alpha\nbeta\nexternal\n", "utf8");
      const future = new Date(Date.now() + 60_000);
      await utimes(filePath, future, future);

      const raw = await tooling.runtime.execute({
        id: "call_2",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
        },
      });

      expect(raw.ok).toBe(false);
      expect("error" in raw ? raw.error : "").toContain("changed");
      expect(await readFile(filePath, "utf8")).toBe("alpha\nbeta\nexternal\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("rejects missing and ambiguous old_string matches", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\nbeta\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        id: "call_1",
        name: "Read",
        args: { file_path: "notes.txt" },
      });

      const missing = await tooling.runtime.execute({
        id: "call_2",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "omega",
          new_string: "delta",
        },
      });
      expect(missing.ok).toBe(false);
      expect("error" in missing ? missing.error : "").toContain("not found");

      const ambiguous = await tooling.runtime.execute({
        id: "call_3",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
        },
      });
      expect(ambiguous.ok).toBe(false);
      expect("replacementCount" in ambiguous ? ambiguous.replacementCount : 0).toBe(2);
      expect(await readFile(filePath, "utf8")).toBe("alpha\nbeta\nbeta\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("replace_all=true replaces every exact string match", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\nbeta\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        id: "call_1",
        name: "Read",
        args: { file_path: "notes.txt" },
      });
      const raw = await tooling.runtime.execute({
        id: "call_2",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
          replace_all: true,
        },
      });

      expect(raw.ok).toBe(true);
      expect("replacementCount" in raw ? raw.replacementCount : 0).toBe(2);
      expect(await readFile(filePath, "utf8")).toBe("alpha\ndelta\ndelta\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("old_string='' creates a file or writes to an empty file only", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const created = await tooling.runtime.execute({
        id: "call_1",
        name: "Edit",
        args: {
          file_path: "created.txt",
          old_string: "",
          new_string: "seed\n",
        },
      });
      expect(created.ok).toBe(true);
      expect(await readFile(path.join(workspace, "created.txt"), "utf8")).toBe(
        "seed\n",
      );

      await writeFile(path.join(workspace, "empty.txt"), "", "utf8");
      const empty = await tooling.runtime.execute({
        id: "call_2",
        name: "Edit",
        args: {
          file_path: "empty.txt",
          old_string: "",
          new_string: "filled\n",
        },
      });
      expect(empty.ok).toBe(true);
      expect(await readFile(path.join(workspace, "empty.txt"), "utf8")).toBe(
        "filled\n",
      );

      const nonEmpty = await tooling.runtime.execute({
        id: "call_3",
        name: "Edit",
        args: {
          file_path: "created.txt",
          old_string: "",
          new_string: "overwrite\n",
        },
      });
      expect(nonEmpty.ok).toBe(false);
      expect(await readFile(path.join(workspace, "created.txt"), "utf8")).toBe(
        "seed\n",
      );
    } finally {
      await rm(workspace, { recursive: true });
    }
  });
});

describe("Glob tool", () => {
  test("finds workspace files, includes dotfiles, and ignores node_modules and .git", async () => {
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
        id: "call_1",
        name: "Glob",
        args: { pattern: "**/*" },
      });

      expect(raw.ok).toBe(true);
      const matches = "matches" in raw ? (raw.matches ?? []) : [];
      expect(matches).toContain(".env.example");
      expect(matches).toContain("src/app.ts");
      expect(matches).not.toContain("node_modules/pkg/ignored.ts");
      expect(matches).not.toContain(".git/config");
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
        id: "call_1",
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

  test("rejects Glob path escape", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-glob-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        id: "call_1",
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
      const call = {
        id: "call_1",
        name: "Glob",
        args: { pattern: "**/*.ts" },
      };
      const raw = await tooling.runtime.execute(call);
      const observation = new ObservationBuilder().build({ call, raw });

      expect(observation.content).toContain('Glob succeeded for pattern="**/*.ts".');
      expect(observation.content).toContain("searchPath=.");
      expect(observation.content).toContain("ignored=node_modules,.git");
      expect(observation.content).toContain("matches:\nsrc/app.ts");
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
        id: "call_1",
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
        id: "call_1",
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
        id: "call_1",
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

  test("count mode returns per-file counts and total matches", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.ts"), "foo\nfoo\n", "utf8");
      await writeFile(path.join(workspace, "b.ts"), "foo\nfoo\nfoo\nbar\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        id: "call_1",
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
        id: "call_1",
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
        id: "call_2",
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
        id: "call_1",
        name: "Grep",
        args: { pattern: "foo", glob: "*.ts" },
      });
      expect("filenames" in globFiltered ? globFiltered.filenames : []).toEqual([
        "a.ts",
      ]);

      const typeFiltered = await tooling.runtime.execute({
        id: "call_2",
        name: "Grep",
        args: { pattern: "foo", type: "js" },
      });
      expect("filenames" in typeFiltered ? typeFiltered.filenames : []).toEqual([
        "b.js",
      ]);
    });
  });

  test("supports case-insensitive and multiline search", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.ts"), "FOO\nbar\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const caseSensitive = await tooling.runtime.execute({
        id: "call_1",
        name: "Grep",
        args: { pattern: "foo" },
      });
      expect("numFiles" in caseSensitive ? caseSensitive.numFiles : -1).toBe(0);

      const caseInsensitive = await tooling.runtime.execute({
        id: "call_2",
        name: "Grep",
        args: { pattern: "foo", "-i": true },
      });
      expect("filenames" in caseInsensitive ? caseInsensitive.filenames : []).toEqual([
        "a.ts",
      ]);

      const withoutMultiline = await tooling.runtime.execute({
        id: "call_3",
        name: "Grep",
        args: { pattern: "FOO.bar" },
      });
      expect("numFiles" in withoutMultiline ? withoutMultiline.numFiles : -1).toBe(0);

      const multiline = await tooling.runtime.execute({
        id: "call_4",
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
        id: "call_1",
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
        id: "call_1",
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
        id: "call_1",
        name: "Grep",
        args: { pattern: "foo", path: "a.ts", output_mode: "content" },
      });

      expect(raw.ok).toBe(true);
      expect("content" in raw ? raw.content : "").toBe("a.ts:1:foo");
    });
  });

  test("rejects path escape and missing paths", async () => {
    await withGrepWorkspace(async (workspace) => {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      const escape = await tooling.runtime.execute({
        id: "call_1",
        name: "Grep",
        args: { pattern: "foo", path: "../outside" },
      });
      expect(escape.ok).toBe(false);
      expect("error" in escape ? escape.error : "").toContain("escapes workspace");

      const missing = await tooling.runtime.execute({
        id: "call_2",
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
        id: "call_1",
        name: "Grep",
        args: { pattern: "foo" },
      });

      expect(raw.ok).toBe(true);
      expect("filenames" in raw ? raw.filenames : []).toEqual(["a.ts"]);
    });
  });

  test("fails with a clear error when ripgrep is missing", async () => {
    await withGrepWorkspace(async (workspace) => {
      const previous = process.env.TINKER_RIPGREP_PATH;
      process.env.TINKER_RIPGREP_PATH = path.join(workspace, "missing-rg");

      try {
        const tooling = createDefaultTooling({ workspaceRoot: workspace });
        const raw = await tooling.runtime.execute({
          id: "call_1",
          name: "Grep",
          args: { pattern: "foo" },
        });

        expect(raw.ok).toBe(false);
        expect("error" in raw ? raw.error : "").toBe(
          "ripgrep is required. Install rg and ensure it is available on PATH.",
        );
      } finally {
        if (previous === undefined) {
          delete process.env.TINKER_RIPGREP_PATH;
        } else {
          process.env.TINKER_RIPGREP_PATH = previous;
        }
      }
    });
  });

  test("renders files_with_matches observations", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.ts"), "foo\n", "utf8");
      await writeFile(path.join(workspace, "b.ts"), "foo\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const call = { id: "call_1", name: "Grep", args: { pattern: "foo" } };
      const raw = await tooling.runtime.execute(call);
      const observation = new ObservationBuilder().build({ call, raw });

      expect(observation.content).toBe("Found 2 files\na.ts\nb.ts");

      const emptyCall = { id: "call_2", name: "Grep", args: { pattern: "missing" } };
      const emptyRaw = await tooling.runtime.execute(emptyCall);
      const emptyObservation = new ObservationBuilder().build({
        call: emptyCall,
        raw: emptyRaw,
      });

      expect(emptyObservation.content).toBe("No files found");
    });
  });

  test("renders content and count observations", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.ts"), "foo\n", "utf8");
      await writeFile(path.join(workspace, "b.ts"), "foo\nfoo\nfoo\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const contentCall = {
        id: "call_1",
        name: "Grep",
        args: { pattern: "foo", path: "a.ts", output_mode: "content" },
      };
      const contentRaw = await tooling.runtime.execute(contentCall);
      const contentObservation = new ObservationBuilder().build({
        call: contentCall,
        raw: contentRaw,
      });
      expect(contentObservation.content).toBe("a.ts:1:foo");

      const noMatchCall = {
        id: "call_2",
        name: "Grep",
        args: { pattern: "missing", output_mode: "content" },
      };
      const noMatchRaw = await tooling.runtime.execute(noMatchCall);
      const noMatchObservation = new ObservationBuilder().build({
        call: noMatchCall,
        raw: noMatchRaw,
      });
      expect(noMatchObservation.content).toBe("No matches found");

      const countCall = {
        id: "call_3",
        name: "Grep",
        args: { pattern: "foo", output_mode: "count" },
      };
      const countRaw = await tooling.runtime.execute(countCall);
      const countObservation = new ObservationBuilder().build({
        call: countCall,
        raw: countRaw,
      });
      expect(countObservation.content).toBe(
        "a.ts:1\nb.ts:3\n\nFound 4 total occurrences across 2 files.",
      );
    });
  });

  test("renders pagination info in observations", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.ts"), "foo\n", "utf8");
      await writeFile(path.join(workspace, "b.ts"), "foo\n", "utf8");
      await writeFile(path.join(workspace, "c.ts"), "foo\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const call = {
        id: "call_1",
        name: "Grep",
        args: { pattern: "foo", head_limit: 1, offset: 1 },
      };
      const raw = await tooling.runtime.execute(call);
      const observation = new ObservationBuilder().build({ call, raw });

      expect(observation.content).toContain("Found 1 file\nb.ts");
      expect(observation.content).toContain(
        "[Showing results with pagination = limit: 1, offset: 1]",
      );
    });
  });

  test("renders failure observations with the pattern", async () => {
    await withGrepWorkspace(async (workspace) => {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const call = {
        id: "call_1",
        name: "Grep",
        args: { pattern: "foo", path: "../outside" },
      };
      const raw = await tooling.runtime.execute(call);
      const observation = new ObservationBuilder().build({ call, raw });

      expect(observation.content).toBe(
        'Grep failed for pattern="foo": Path escapes workspace.',
      );
    });
  });
});
