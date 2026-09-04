import { describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ObservationBuilder } from "../observation/observation-builder";
import { decodeStoredToolRawResult } from "../session/session-store";
import { createDefaultTooling } from "./helpers/tools-support";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";

isolateTinkerHome();

describe("Delete tool", () => {
  test("registers the exact schema after Edit and before Bash", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-delete-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const definitions = tooling.registry.definitions();
      const names = definitions.map((definition) => definition.name);
      const definition = definitions.find((candidate) => candidate.name === "Delete");

      expect(definition).toEqual({
        name: "Delete",
        description:
          "Delete one existing regular file. Directories and symbolic links are not supported.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            file_path: {
              type: "string",
              description: "Workspace-relative path or absolute path.",
            },
          },
          required: ["file_path"],
        },
      });
      expect(names.slice(names.indexOf("Edit"), names.indexOf("Bash") + 1)).toEqual([
        "Edit",
        "Delete",
        "Bash",
      ]);
      expect(
        decodeStoredToolRawResult({
          kind: "delete",
          ok: true,
          filePath: "obsolete.ts",
          absolutePath: path.join(workspace, "obsolete.ts"),
        }),
      ).toEqual({
        kind: "delete",
        ok: true,
        filePath: "obsolete.ts",
        absolutePath: path.join(workspace, "obsolete.ts"),
      });
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("deletes a workspace file without a snapshot and renders success", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-delete-"));
    const filePath = path.join(workspace, "obsolete.ts");

    try {
      await writeFile(filePath, "obsolete\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const call = {
        providerToolCallId: "call_1",
        name: "Delete",
        args: { file_path: "obsolete.ts" },
      };
      const raw = await tooling.runtime.execute(call);
      const observation = new ObservationBuilder().build({
        call: tooling.testRuntime.toolCall(call),
        raw,
      });

      expect(raw).toEqual({
        kind: "delete",
        ok: true,
        filePath: "obsolete.ts",
        absolutePath: filePath,
      });
      expect(lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(tooling.snapshots.size).toBe(0);
      expect(observation.displayText).toBe("Delete succeeded for obsolete.ts.");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("deletes an absolute file outside the workspace", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "tinker-delete-absolute-"));
    const workspace = path.join(parent, "workspace");
    const filePath = path.join(parent, "outside.txt");

    try {
      await mkdir(workspace);
      await writeFile(filePath, "outside\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Delete",
        args: { file_path: filePath },
      });

      expect(raw).toMatchObject({
        kind: "delete",
        ok: true,
        filePath,
        absolutePath: filePath,
      });
      expect(lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(parent, { recursive: true });
    }
  });

  test("deletes files with Read, Write, or Edit snapshots and clears each snapshot", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-delete-snapshot-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const readPath = path.join(workspace, "read.txt");
      await writeFile(readPath, "read\n", "utf8");
      await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "read.txt" },
      });
      expect(tooling.snapshots.get(readPath)?.source).toBe("read");

      const readDelete = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Delete",
        args: { file_path: "read.txt" },
      });
      expect(readDelete.ok).toBe(true);
      expect(tooling.snapshots.has(readPath)).toBe(false);

      const writePath = path.join(workspace, "write.txt");
      await tooling.runtime.execute({
        providerToolCallId: "call_3",
        name: "Write",
        args: { file_path: "write.txt", content: "write\n" },
      });
      expect(tooling.snapshots.get(writePath)?.source).toBe("write");

      const writeDelete = await tooling.runtime.execute({
        providerToolCallId: "call_4",
        name: "Delete",
        args: { file_path: "write.txt" },
      });
      expect(writeDelete.ok).toBe(true);
      expect(tooling.snapshots.has(writePath)).toBe(false);

      const editPath = path.join(workspace, "edit.txt");
      await writeFile(editPath, "before\n", "utf8");
      await tooling.runtime.execute({
        providerToolCallId: "call_5",
        name: "Read",
        args: { file_path: "edit.txt" },
      });
      await tooling.runtime.execute({
        providerToolCallId: "call_6",
        name: "Edit",
        args: {
          file_path: "edit.txt",
          old_string: "before",
          new_string: "after",
        },
      });
      expect(tooling.snapshots.get(editPath)?.source).toBe("edit");

      const editDelete = await tooling.runtime.execute({
        providerToolCallId: "call_7",
        name: "Delete",
        args: { file_path: "edit.txt" },
      });
      expect(editDelete.ok).toBe(true);
      expect(tooling.snapshots.has(editPath)).toBe(false);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("validates arguments and workspace-relative paths", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-delete-args-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const cases = [
        {
          args: null,
          filePath: "",
          error: "Delete arguments must be an object.",
        },
        {
          args: [],
          filePath: "",
          error: "Delete arguments must be an object.",
        },
        {
          args: {},
          filePath: "",
          error: "Delete.file_path must be a string.",
        },
        {
          args: { file_path: 42 },
          filePath: "",
          error: "Delete.file_path must be a string.",
        },
        {
          args: { file_path: "" },
          filePath: "",
          error: "Path is required.",
        },
        {
          args: { file_path: " \t " },
          filePath: " \t ",
          error: "Path is required.",
        },
        {
          args: { file_path: "../outside.txt" },
          filePath: "../outside.txt",
          error: "Path escapes workspace.",
        },
      ];

      for (const [index, testCase] of cases.entries()) {
        const raw = await tooling.runtime.execute({
          providerToolCallId: `call_${index + 1}`,
          name: "Delete",
          args: testCase.args,
        });

        expect(raw).toMatchObject({
          kind: "delete",
          ok: false,
          filePath: testCase.filePath,
          error: testCase.error,
        });
      }
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("normalizes missing files and ENOTDIR to ordinary Delete failures", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-delete-missing-"));

    try {
      await writeFile(path.join(workspace, "parent-file"), "parent\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      for (const filePath of ["missing.txt", "parent-file/child.txt"]) {
        const call = {
          providerToolCallId: `call_${filePath}`,
          name: "Delete",
          args: { file_path: filePath },
        };
        const raw = await tooling.runtime.execute(call);
        const observation = new ObservationBuilder().build({
          call: tooling.testRuntime.toolCall(call),
          raw,
        });

        expect(raw).toMatchObject({
          kind: "delete",
          ok: false,
          filePath,
          error: "File does not exist.",
        });
        expect(observation.displayText).toBe(
          `Delete failed for ${filePath}: File does not exist.`,
        );
      }
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("rejects empty and non-empty directories without changing them", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-delete-directory-"));
    const emptyPath = path.join(workspace, "empty");
    const nonEmptyPath = path.join(workspace, "non-empty");
    const childPath = path.join(nonEmptyPath, "child.txt");

    try {
      await mkdir(emptyPath);
      await mkdir(nonEmptyPath);
      await writeFile(childPath, "keep\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      for (const filePath of ["empty", "non-empty"]) {
        const raw = await tooling.runtime.execute({
          providerToolCallId: `call_${filePath}`,
          name: "Delete",
          args: { file_path: filePath },
        });

        expect(raw).toMatchObject({
          kind: "delete",
          ok: false,
          filePath,
          error: "Path is not a regular file.",
        });
      }

      expect((await lstat(emptyPath)).isDirectory()).toBe(true);
      expect((await lstat(nonEmptyPath)).isDirectory()).toBe(true);
      expect(await readFile(childPath, "utf8")).toBe("keep\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("rejects symbolic links without changing the link or its target", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-delete-symlink-"));
    const targetPath = path.join(workspace, "target.txt");
    const linkPath = path.join(workspace, "current-config");

    try {
      await writeFile(targetPath, "keep\n", "utf8");
      await symlink(targetPath, linkPath);
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Delete",
        args: { file_path: "current-config" },
      });

      expect(raw).toMatchObject({
        kind: "delete",
        ok: false,
        filePath: "current-config",
        error: "Symbolic links are not supported.",
      });
      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(await readFile(targetPath, "utf8")).toBe("keep\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("rejects a FIFO without opening or removing it", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-delete-fifo-"));
    const fifoPath = path.join(workspace, "events.pipe");

    try {
      const child = Bun.spawnSync(["mkfifo", fifoPath]);
      if (child.exitCode !== 0) {
        throw new Error(`mkfifo failed: ${child.stderr.toString()}`);
      }
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Delete",
        args: { file_path: "events.pipe" },
      });

      expect(raw).toMatchObject({
        kind: "delete",
        ok: false,
        filePath: "events.pipe",
        error: "Path is not a regular file.",
      });
      expect((await lstat(fifoPath)).isFIFO()).toBe(true);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("keeps the file and snapshot when rm fails", async () => {
    if (process.getuid?.() === 0) {
      return;
    }

    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "tinker-delete-permission-"),
    );
    const filePath = path.join(workspace, "protected.txt");

    try {
      await writeFile(filePath, "keep\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "protected.txt" },
      });
      const snapshot = tooling.snapshots.get(filePath);
      await chmod(workspace, 0o555);

      let raw;
      try {
        raw = await tooling.runtime.execute({
          providerToolCallId: "call_2",
          name: "Delete",
          args: { file_path: "protected.txt" },
        });
      } finally {
        await chmod(workspace, 0o755);
      }

      expect(raw).toMatchObject({
        kind: "delete",
        ok: false,
        filePath: "protected.txt",
      });
      expect("error" in raw ? raw.error : "").toMatch(
        /EACCES|EPERM|permission denied/i,
      );
      expect(await readFile(filePath, "utf8")).toBe("keep\n");
      expect(tooling.snapshots.get(filePath)).toEqual(snapshot);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });
});
