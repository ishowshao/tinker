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
