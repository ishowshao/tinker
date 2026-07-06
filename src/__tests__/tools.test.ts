import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
