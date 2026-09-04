import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ObservationBuilder } from "../observation/observation-builder";
import { createDefaultTooling } from "./helpers/tools-support";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";

isolateTinkerHome();

describe("Edit tool", () => {
  test("replaces a single exact string after Read and keeps chained edits authorized", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt" },
      });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_2",
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
        providerToolCallId: "call_3",
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

  test("edits an absolute file path outside the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));
    const workspace = path.join(root, "workspace");
    const filePath = path.join(root, "outside.txt");

    try {
      await mkdir(workspace);
      await writeFile(filePath, "old value\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: filePath },
      });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Edit",
        args: {
          file_path: filePath,
          old_string: "old value",
          new_string: "new value",
        },
      });

      expect(raw.ok).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("new value\n");
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test("returns a structured patch describing the edit", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt" },
      });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_2",
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
        providerToolCallId: "call_1",
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

  test("creates missing parent directories in Edit creation mode", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const filePath = path.join(workspace, "src", "generated", "client.ts");
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Edit",
        args: {
          file_path: "src/generated/client.ts",
          old_string: "",
          new_string: "export const client = true;\n",
        },
      });

      expect(raw.ok).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("export const client = true;\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("does not create parent directories for a missing ordinary Edit target", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));
    const parentPath = path.join(workspace, "missing", "nested");

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Edit",
        args: {
          file_path: "missing/nested/notes.txt",
          old_string: "old",
          new_string: "new",
        },
      });

      expect(raw.ok).toBe(false);
      expect("error" in raw ? raw.error : "").toBe("File does not exist.");
      expect(stat(parentPath)).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("fails when an Edit creation parent path is a file", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));
    const blocker = path.join(workspace, "blocker");

    try {
      await writeFile(blocker, "unchanged\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Edit",
        args: {
          file_path: "blocker/nested/notes.txt",
          old_string: "",
          new_string: "new\n",
        },
      });

      expect(raw.ok).toBe(false);
      expect("error" in raw ? raw.error : "").toContain(
        "Failed to create parent directory:",
      );
      expect("error" in raw ? raw.error : "").toContain("not a directory");
      expect(await readFile(blocker, "utf8")).toBe("unchanged\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("reports a missing target when an ordinary Edit parent path is a file", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));
    const blocker = path.join(workspace, "blocker");

    try {
      await writeFile(blocker, "unchanged\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Edit",
        args: {
          file_path: "blocker/nested/notes.txt",
          old_string: "old",
          new_string: "new",
        },
      });

      expect(raw.ok).toBe(false);
      expect("error" in raw ? raw.error : "").toBe("File does not exist.");
      expect(await readFile(blocker, "utf8")).toBe("unchanged\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("allows Edit after a successful paginated Read", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt", offset: 2, limit: 1 },
      });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
        },
      });

      expect(raw.ok).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("alpha\ndelta\ngamma\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("requires a successful Read before editing", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const call = tooling.testRuntime.toolCall({
        providerToolCallId: "call_1",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
        },
      });

      const raw = await tooling.runtime.execute(call);
      expect(raw.ok).toBe(false);
      expect("requiredReadBeforeEdit" in raw ? raw.requiredReadBeforeEdit : false).toBe(
        true,
      );
      const observation = new ObservationBuilder().build({ call, raw });
      expect(observation.displayText).toBe(
        "Edit failed for notes.txt: File must be read before Edit. Call Read on this file before trying Edit again.",
      );
      expect(await readFile(filePath, "utf8")).toBe("alpha\nbeta\ngamma\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("allows Edit after Write refreshes the known version", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt", offset: 1, limit: 1 },
      });
      const write = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Write",
        args: { file_path: "notes.txt", content: "alpha\nbeta\ngamma\n" },
      });
      expect(write.ok).toBe(true);

      const edit = await tooling.runtime.execute({
        providerToolCallId: "call_3",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
        },
      });
      expect(edit.ok).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("alpha\ndelta\ngamma\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("allows Edit immediately after Write creates a file", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      const write = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Write",
        args: { file_path: "notes.txt", content: "alpha\nbeta\n" },
      });
      expect(write.ok).toBe(true);

      const edit = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
        },
      });

      expect(edit.ok).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("alpha\ndelta\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("rejects Edit after a file written by Write changes externally", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      const write = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Write",
        args: { file_path: "notes.txt", content: "alpha\nbeta\n" },
      });
      expect(write.ok).toBe(true);
      const snapshot = tooling.snapshots.get(filePath);
      if (snapshot === undefined) {
        throw new Error("Write did not record a file snapshot.");
      }

      await writeFile(filePath, "alpha\nbeta\nexternal\n", "utf8");
      const earlier = new Date(snapshot.mtimeMs - 60_000);
      await utimes(filePath, earlier, earlier);
      expect((await stat(filePath)).mtimeMs).toBeLessThan(snapshot.mtimeMs);

      const edit = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
        },
      });

      expect(edit.ok).toBe(false);
      expect("currentSha256" in edit ? edit.currentSha256 : undefined).toBeString();
      expect("lastObservedSha256" in edit ? edit.lastObservedSha256 : undefined).toBe(
        snapshot.sha256,
      );
      expect("error" in edit ? edit.error : "").toBe(
        "File changed after it was last observed. Read it again before Edit.",
      );
      expect(await readFile(filePath, "utf8")).toBe("alpha\nbeta\nexternal\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("requires Read when a new runtime has no snapshot from an earlier Write", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      const firstTooling = createDefaultTooling({ workspaceRoot: workspace });
      const write = await firstTooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Write",
        args: { file_path: "notes.txt", content: "alpha\nbeta\n" },
      });
      expect(write.ok).toBe(true);

      const nextTooling = createDefaultTooling({ workspaceRoot: workspace });
      const edit = await nextTooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
        },
      });

      expect(edit.ok).toBe(false);
      expect(
        "requiredReadBeforeEdit" in edit ? edit.requiredReadBeforeEdit : false,
      ).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("alpha\nbeta\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("rejects Edit when content changed even with an older mtime", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt" },
      });
      const snapshot = tooling.snapshots.get(filePath);
      if (snapshot === undefined) {
        throw new Error("Read did not record a file snapshot.");
      }
      await writeFile(filePath, "alpha\nbeta\nexternal\n", "utf8");
      const earlier = new Date(snapshot.mtimeMs - 60_000);
      await utimes(filePath, earlier, earlier);
      expect((await stat(filePath)).mtimeMs).toBeLessThan(snapshot.mtimeMs);

      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
        },
      });

      expect(raw.ok).toBe(false);
      expect("error" in raw ? raw.error : "").toBe(
        "File changed after it was last observed. Read it again before Edit.",
      );
      expect(await readFile(filePath, "utf8")).toBe("alpha\nbeta\nexternal\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("allows Edit when only mtime changed after Read", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt" },
      });
      const future = new Date(Date.now() + 60_000);
      await utimes(filePath, future, future);

      const edit = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
        },
      });

      expect(edit.ok).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("alpha\ndelta\n");
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
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt" },
      });

      const missing = await tooling.runtime.execute({
        providerToolCallId: "call_2",
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
        providerToolCallId: "call_3",
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
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt" },
      });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_2",
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
        providerToolCallId: "call_1",
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
        providerToolCallId: "call_2",
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
        providerToolCallId: "call_3",
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
