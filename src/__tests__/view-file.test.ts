import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadViewFile } from "../tui/view-file";

describe("view file loader", () => {
  test("loads workspace-relative UTF-8 text and preserves logical lines", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-view-workspace-"));
    try {
      await mkdir(path.join(workspace, "docs"));
      await writeFile(
        path.join(workspace, "docs", "design notes.md"),
        "first\r\nsecond\tvalue\r\n",
      );

      const file = await loadViewFile(workspace, "docs/design notes.md");

      expect(file.displayPath).toBe("docs/design notes.md");
      expect(file.lines).toEqual(["first", "second\tvalue"]);
      expect(file.sizeBytes).toBeGreaterThan(0);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("loads a readable absolute path outside the workspace", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-view-workspace-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "tinker-view-outside-"));
    try {
      const filePath = path.join(outside, "outside.ts");
      await writeFile(filePath, "export const outside = true;\n");

      const file = await loadViewFile(workspace, filePath);

      expect(file.absolutePath).toBe(file.displayPath);
      expect(file.lines).toEqual(["export const outside = true;"]);
    } finally {
      await rm(workspace, { recursive: true });
      await rm(outside, { recursive: true });
    }
  });

  test("rejects lexical and symlink escapes for relative paths", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-view-workspace-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "tinker-view-outside-"));
    try {
      const outsideFile = path.join(outside, "outside.ts");
      await writeFile(outsideFile, "outside\n");
      await symlink(outsideFile, path.join(workspace, "linked.ts"));

      expect(await failureMessage(loadViewFile(workspace, "../outside.ts"))).toContain(
        "Relative path escapes the workspace",
      );
      expect(await failureMessage(loadViewFile(workspace, "linked.ts"))).toContain(
        "Relative path resolves outside the workspace",
      );
    } finally {
      await rm(workspace, { recursive: true });
      await rm(outside, { recursive: true });
    }
  });

  test("rejects missing paths, directories, invalid UTF-8, and control bytes", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-view-workspace-"));
    try {
      await mkdir(path.join(workspace, "folder"));
      await writeFile(
        path.join(workspace, "binary.dat"),
        Uint8Array.from([0xff, 0xfe]),
      );
      await writeFile(
        path.join(workspace, "control.txt"),
        Uint8Array.from([97, 0, 98]),
      );

      expect(await failureMessage(loadViewFile(workspace, "missing.ts"))).toContain(
        "File does not exist",
      );
      expect(await failureMessage(loadViewFile(workspace, "folder"))).toContain(
        "Path is not a regular file",
      );
      expect(await failureMessage(loadViewFile(workspace, "binary.dat"))).toContain(
        "File is not valid UTF-8 text",
      );
      expect(await failureMessage(loadViewFile(workspace, "control.txt"))).toContain(
        "File contains non-text control characters",
      );
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("accepts an empty text file", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-view-workspace-"));
    try {
      await writeFile(path.join(workspace, "empty.ts"), "");

      const file = await loadViewFile(workspace, "empty.ts");

      expect(file.lines).toEqual([]);
      expect(file.sizeBytes).toBe(0);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });
});

async function failureMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the operation to fail.");
}
