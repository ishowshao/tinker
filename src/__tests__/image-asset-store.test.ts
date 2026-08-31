import { describe, expect, test } from "bun:test";
import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createUuidV7 } from "../ids/uuid-v7";
import { ImageAssetStore } from "../image/image-asset-store";
import { IMAGE_INPUT_POLICY } from "../image/image-input-policy";
import {
  ImageNotRecognizedError,
  UnsupportedImageFormatError,
} from "../image/image-probe";
import type { ImageAssetId } from "../image/image-types";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";

isolateTinkerHome();

describe("ImageAssetStore", () => {
  test("imports PNG, JPEG, and static WebP into a private content-addressed store", async () => {
    await withWorkspace(async (workspace) => {
      const store = await ImageAssetStore.open({ workspaceRoot: workspace });
      const cases = [
        ["sample.png", "png", "image/png"],
        ["sample.jpg", "jpeg", "image/jpeg"],
        ["sample.webp", "webp", "image/webp"],
      ] as const;

      for (const [name, format, mimeType] of cases) {
        const bytes = await imageBytes(format, 3, 2);
        await writeFile(path.join(workspace, name), bytes);
        const imported = await store.importWorkspaceFile(name);

        expect(imported).toMatchObject({
          originalName: name,
          asset: {
            mimeType,
            byteLength: bytes.length,
            width: 3,
            height: 2,
          },
        });
        expect(
          (await readFile(store.pathFor(imported.asset.assetId))).toString("hex"),
        ).toBe(bytes.toString("hex"));
        expect((await stat(store.pathFor(imported.asset.assetId))).mode & 0o777).toBe(
          0o600,
        );
        await store.verify(imported.asset);
      }

      expect((await stat(store.root)).mode & 0o777).toBe(0o700);
      expect((await stat(path.dirname(store.root))).mode & 0o777).toBe(0o700);
    });
  });

  test("deduplicates identical bytes while preserving per-attachment names", async () => {
    await withWorkspace(async (workspace) => {
      const store = await ImageAssetStore.open({ workspaceRoot: workspace });
      const bytes = await imageBytes("png", 4, 3);
      await writeFile(path.join(workspace, "first.png"), bytes);
      await writeFile(path.join(workspace, "second.png"), bytes);

      const [first, second] = await Promise.all([
        store.importWorkspaceFile("first.png"),
        store.importWorkspaceFile("second.png"),
      ]);

      expect(first.asset.assetId).toBe(second.asset.assetId);
      expect(first.originalName).toBe("first.png");
      expect(second.originalName).toBe("second.png");
      expect((await readFile(store.pathFor(first.asset.assetId))).toString("hex")).toBe(
        bytes.toString("hex"),
      );
    });
  });

  test("rejects ordinary files, unsupported containers, fake suffixes, and corruption", async () => {
    await withWorkspace(async (workspace) => {
      const store = await ImageAssetStore.open({ workspaceRoot: workspace });
      await writeFile(path.join(workspace, "notes.txt"), "not an image");
      await writeFile(path.join(workspace, "fake.png"), "not a png");
      await writeFile(path.join(workspace, "still.gif"), "GIF89a garbage");
      await writeFile(
        path.join(workspace, "broken.png"),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );

      expect(store.importWorkspaceFile("notes.txt")).rejects.toBeInstanceOf(
        ImageNotRecognizedError,
      );
      expect(store.importWorkspaceFile("fake.png")).rejects.toBeInstanceOf(
        UnsupportedImageFormatError,
      );
      expect(store.importWorkspaceFile("still.gif")).rejects.toBeInstanceOf(
        UnsupportedImageFormatError,
      );
      expect(store.importWorkspaceFile("broken.png")).rejects.toThrow("PNG container");
    });
  });

  test("rejects dimension, pixel, and stat-size limits", async () => {
    await withWorkspace(async (workspace) => {
      const store = await ImageAssetStore.open({ workspaceRoot: workspace });
      await writeFile(
        path.join(workspace, "too-wide.png"),
        await imageBytes("png", IMAGE_INPUT_POLICY.maxLongEdge + 1, 1),
      );
      await writeFile(
        path.join(workspace, "too-many-pixels.png"),
        await imageBytes("png", 4096, 2161),
      );
      const oversized = path.join(workspace, "oversized.png");
      await writeFile(oversized, Buffer.from("x"));
      await truncate(oversized, IMAGE_INPUT_POLICY.maxBytesPerImage + 1);

      expect(store.importWorkspaceFile("too-wide.png")).rejects.toThrow("exceed");
      expect(store.importWorkspaceFile("too-many-pixels.png")).rejects.toThrow();
      expect(store.importWorkspaceFile("oversized.png")).rejects.toThrow(
        `${IMAGE_INPUT_POLICY.maxBytesPerImage + 1} bytes`,
      );
    });
  });

  test("rejects workspace escapes and symlink sources", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "tinker-image-outside-"));
    try {
      await withWorkspace(async (workspace) => {
        const store = await ImageAssetStore.open({ workspaceRoot: workspace });
        const bytes = await imageBytes("png", 2, 2);
        const outsideFile = path.join(outside, "outside.png");
        await writeFile(outsideFile, bytes);
        await symlink(outsideFile, path.join(workspace, "linked.png"));

        expect(store.importWorkspaceFile(outsideFile)).rejects.toThrow(
          "outside the workspace",
        );
        expect(store.importWorkspaceFile("linked.png")).rejects.toThrow("non-symlink");
      });
    } finally {
      await rm(outside, { recursive: true });
    }
  });

  test("never overwrites a corrupt or symlinked published target", async () => {
    await withWorkspace(async (workspace) => {
      const store = await ImageAssetStore.open({ workspaceRoot: workspace });
      const source = path.join(workspace, "source.png");
      const bytes = await imageBytes("png", 3, 3);
      await writeFile(source, bytes);
      const imported = await store.importWorkspaceFile("source.png");
      const target = store.pathFor(imported.asset.assetId);

      const corrupt = Buffer.from(bytes);
      corrupt[corrupt.length - 1] ^= 0xff;
      await writeFile(target, corrupt);
      expect(store.readVerified(imported.asset)).rejects.toThrow();
      expect(store.importWorkspaceFile("source.png")).rejects.toThrow();
      expect((await readFile(target)).toString("hex")).toBe(corrupt.toString("hex"));

      await rm(target);
      await symlink(source, target);
      expect(store.importWorkspaceFile("source.png")).rejects.toThrow("not regular");
      expect((await lstat(target)).isSymbolicLink()).toBe(true);
    });
  });

  test("cleans only stale, strictly named regular staging files", async () => {
    await withWorkspace(async (workspace) => {
      const warnings: string[] = [];
      const store = await ImageAssetStore.open({
        workspaceRoot: workspace,
        onWarning: (warning) => warnings.push(warning),
      });
      const staleName = `.staging-image-${createUuidV7()}`;
      const recentName = `.staging-image-${createUuidV7()}`;
      const futureName = `.staging-image-${createUuidV7()}`;
      const linkName = `.staging-image-${createUuidV7()}`;
      const unknownName = ".staging-image-not-a-uuid";
      const publishedName = "a".repeat(64);
      for (const name of [
        staleName,
        recentName,
        futureName,
        unknownName,
        publishedName,
      ]) {
        await writeFile(path.join(store.root, name), name);
      }
      await symlink(path.join(store.root, recentName), path.join(store.root, linkName));
      const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1_000);
      await utimes(path.join(store.root, staleName), staleDate, staleDate);
      const futureDate = new Date(Date.now() + 60 * 60 * 1_000);
      await utimes(path.join(store.root, futureName), futureDate, futureDate);

      await ImageAssetStore.open({
        workspaceRoot: workspace,
        onWarning: (warning) => warnings.push(warning),
      });

      expect(lstat(path.join(store.root, staleName))).rejects.toMatchObject({
        code: "ENOENT",
      });
      for (const name of [
        recentName,
        futureName,
        linkName,
        unknownName,
        publishedName,
      ]) {
        expect(await lstat(path.join(store.root, name))).toBeTruthy();
      }
      expect(warnings).toContain(
        `Image staging file has an invalid mtime: ${futureName}`,
      );
    });
  });

  test("rejects unbranded path traversal and noncanonical asset IDs", async () => {
    await withWorkspace(async (workspace) => {
      const store = await ImageAssetStore.open({ workspaceRoot: workspace });
      for (const value of ["../escape", "A".repeat(64), "g".repeat(64)]) {
        expect(() => store.pathFor(value as ImageAssetId)).toThrow(
          "Invalid image asset ID",
        );
      }
    });
  });
});

async function imageBytes(
  format: "png" | "jpeg" | "webp",
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 24, g: 80, b: 160 },
    },
  })
    .toFormat(format)
    .toBuffer();
}

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-image-store-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true });
  }
}
