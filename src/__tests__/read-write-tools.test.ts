import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDefaultTooling } from "./helpers/tools-support";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";

isolateTinkerHome();

describe("Read and Write tools", () => {
  test("reads a workspace file with metadata", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tools-"));

    try {
      await writeFile(path.join(workspace, "notes.txt"), "a\nb\nc\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt", offset: 2, limit: 100 },
      });

      expect(raw.ok).toBe(true);
      expect("content" in raw ? raw.content : "").toBe("b\nc");
      expect("contentBytes" in raw ? raw.contentBytes : 0).toBe(3);
      expect("totalLines" in raw ? raw.totalLines : 0).toBe(3);
      expect("endLine" in raw ? raw.endLine : 0).toBe(3);
      expect("sha256" in raw ? raw.sha256 : undefined).toBeString();
      expect("truncated" in raw).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("fails an oversized unpaginated Read without returning partial content", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-read-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
      const tooling = createDefaultTooling({
        workspaceRoot: workspace,
        maxReadContentBytes: 15,
      });

      const read = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt" },
      });

      expect(read.ok).toBe(false);
      expect("content" in read ? read.content : undefined).toBeUndefined();
      expect("error" in read ? read.error : "").toBe(
        "File content (16 bytes) exceeds maximum allowed size (15 bytes). Use offset and limit parameters to read specific portions of the file.",
      );
      expect(tooling.snapshots.size).toBe(0);

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
      expect(
        "requiredReadBeforeEdit" in edit ? edit.requiredReadBeforeEdit : false,
      ).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("alpha\nbeta\ngamma\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("accepts exactly 262144 bytes and rejects 262145 bytes by default", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-read-"));

    try {
      await writeFile(
        path.join(workspace, "at-limit.txt"),
        `${"x".repeat(131_072)}\n${"y".repeat(131_071)}`,
        "utf8",
      );
      await writeFile(
        path.join(workspace, "over-limit.txt"),
        `${"x".repeat(131_072)}\n${"y".repeat(131_072)}`,
        "utf8",
      );
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      const atLimit = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "at-limit.txt" },
      });
      expect(atLimit.ok).toBe(true);
      expect("contentBytes" in atLimit ? atLimit.contentBytes : 0).toBe(262_144);

      const overLimit = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Read",
        args: { file_path: "over-limit.txt" },
      });
      expect(overLimit.ok).toBe(false);
      expect("error" in overLimit ? overLimit.error : "").toContain(
        "File content (262145 bytes) exceeds maximum allowed size (262144 bytes).",
      );
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("fails an oversized explicit range and accepts a smaller page", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-read-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
      const tooling = createDefaultTooling({
        workspaceRoot: workspace,
        maxReadContentBytes: 9,
      });

      const oversized = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt", offset: 2, limit: 2 },
      });
      expect(oversized.ok).toBe(false);
      expect("error" in oversized ? oversized.error : "").toBe(
        "Requested lines 2-3 contain 10 bytes and exceed the 9-byte Read limit. Reduce limit to request a smaller line range.",
      );

      const page = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Read",
        args: { file_path: "notes.txt", offset: 2, limit: 1 },
      });
      expect(page.ok).toBe(true);
      expect("content" in page ? page.content : "").toBe("beta");

      const edit = await tooling.runtime.execute({
        providerToolCallId: "call_3",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "gamma",
          new_string: "omega",
        },
      });
      expect(edit.ok).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("alpha\nbeta\nomega\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("reports a line that cannot fit within line-based pagination", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-read-"));

    try {
      await writeFile(path.join(workspace, "single-line.txt"), "x".repeat(11), "utf8");
      const tooling = createDefaultTooling({
        workspaceRoot: workspace,
        maxReadContentBytes: 10,
      });

      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "single-line.txt", offset: 1, limit: 1 },
      });

      expect(raw.ok).toBe(false);
      expect("error" in raw ? raw.error : "").toBe(
        "Line 1 is 11 bytes and exceeds the 10-byte Read limit. This line cannot be read with line-based pagination.",
      );
      expect(tooling.snapshots.size).toBe(0);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("rejects an offset beyond EOF without authorizing Edit", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-read-"));

    try {
      await writeFile(path.join(workspace, "notes.txt"), "a\nb\nc\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt", offset: 4, limit: 1 },
      });

      expect(raw.ok).toBe(false);
      expect("error" in raw ? raw.error : "").toBe(
        "Read.offset 4 exceeds the file's 3 lines.",
      );
      expect(tooling.snapshots.size).toBe(0);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("reads an empty file without pagination and records a valid Read", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-read-"));

    try {
      const filePath = path.join(workspace, "empty.txt");
      await writeFile(filePath, "", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "empty.txt" },
      });

      expect(raw.ok).toBe(true);
      expect("content" in raw ? raw.content : undefined).toBe("");
      expect("totalLines" in raw ? raw.totalLines : undefined).toBe(0);
      expect(tooling.snapshots.get(filePath)?.source).toBe("read");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("keeps the last valid Read when a later Read request is too large", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-read-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
      const tooling = createDefaultTooling({
        workspaceRoot: workspace,
        maxReadContentBytes: 5,
      });

      const page = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt", offset: 2, limit: 1 },
      });
      expect(page.ok).toBe(true);

      const oversized = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Read",
        args: { file_path: "notes.txt" },
      });
      expect(oversized.ok).toBe(false);

      const edit = await tooling.runtime.execute({
        providerToolCallId: "call_3",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "gamma",
          new_string: "omega",
        },
      });
      expect(edit.ok).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("alpha\nbeta\nomega\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("rejects path escape", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tools-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "../outside.txt" },
      });

      expect(raw.ok).toBe(false);
      expect("error" in raw ? raw.error : "").toContain("escapes workspace");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("reads and writes an absolute file path outside the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tinker-tools-"));
    const workspace = path.join(root, "workspace");
    const filePath = path.join(root, "outside.txt");

    try {
      await mkdir(workspace);
      await writeFile(filePath, "before\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      const read = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: filePath },
      });
      expect(read.ok).toBe(true);
      expect("content" in read ? read.content : "").toBe("before");

      const write = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Write",
        args: { file_path: filePath, content: "after\n" },
      });
      expect(write.ok).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("after\n");
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test("writes a new file", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tools-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
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

  test("creates missing parent directories for a new file", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tools-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const filePath = path.join(workspace, "src", "generated", "api", "client.ts");
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Write",
        args: {
          file_path: "src/generated/api/client.ts",
          content: "export const client = true;\n",
        },
      });

      expect(raw.ok).toBe(true);
      expect((await stat(path.dirname(filePath))).isDirectory()).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("export const client = true;\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("creates missing parent directories for an absolute file path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tinker-tools-"));
    const workspace = path.join(root, "workspace");
    const filePath = path.join(root, "outside", "nested", "notes.txt");

    try {
      await mkdir(workspace);
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Write",
        args: { file_path: filePath, content: "outside\n" },
      });

      expect(raw.ok).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("outside\n");
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test("fails when a Write parent path is a file", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tools-"));
    const blocker = path.join(workspace, "blocker");

    try {
      await writeFile(blocker, "unchanged\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Write",
        args: { file_path: "blocker/nested/notes.txt", content: "new\n" },
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

  test("returns a structured patch when overwriting after Read", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tools-"));

    try {
      await writeFile(path.join(workspace, "notes.txt"), "old\nsame\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt" },
      });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_2",
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
        providerToolCallId: "call_1",
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
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt" },
      });
      await writeFile(filePath, "external\n", "utf8");

      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_2",
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
