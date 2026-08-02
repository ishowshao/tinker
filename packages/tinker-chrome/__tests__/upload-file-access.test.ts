import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveUploadFilePath } from "../src/upload-file-access";

describe("Tinker Chrome upload file access", () => {
  test("allows canonical files inside MCP roots and the temporary directory", async () => {
    const packagePath = path.resolve(import.meta.dir, "../package.json");
    expect(
      resolveUploadFilePath(packagePath, [
        pathToFileURL(path.dirname(packagePath)).href,
      ]),
    ).resolves.toBe(await realpath(packagePath));

    const directory = await mkdtemp(path.join(tmpdir(), "tinker-upload-access-"));
    const filePath = path.join(directory, "fixture.txt");
    await writeFile(filePath, "fixture", "utf8");
    try {
      expect(resolveUploadFilePath(filePath, [])).resolves.toBe(
        await realpath(filePath),
      );
    } finally {
      await unlink(filePath);
      await rmdir(directory);
    }
  });

  test("rejects paths outside roots, relative paths, and missing files", async () => {
    const packagePath = path.resolve(import.meta.dir, "../package.json");
    expect(resolveUploadFilePath(packagePath, [])).rejects.toMatchObject({
      code: "FILE_ACCESS_DENIED",
      outcome: "not_started",
    });
    expect(resolveUploadFilePath("fixture.txt", [])).rejects.toMatchObject({
      code: "FILE_ACCESS_DENIED",
    });
    expect(
      resolveUploadFilePath(path.join(tmpdir(), "missing-tinker-upload"), []),
    ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });
});
