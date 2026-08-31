import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { createUuidV7 } from "../ids/uuid-v7";
import { IMAGE_INPUT_POLICY } from "./image-input-policy";
import { probeImageBytes } from "./image-probe";
import {
  normalizeOriginalImageName,
  parseImageAssetId,
  validateImageAssetRef,
  type ImageAssetId,
  type ImageAssetRef,
} from "./image-types";
import { canonicalHomeRoot, workspaceStorageRoot } from "../session/workspace-storage";

const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const STAGING_PATTERN =
  /^\.staging-image-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ImportedImageAsset = {
  readonly asset: ImageAssetRef;
  readonly originalName: string;
};

export class ImageAssetStore {
  readonly workspaceRoot: string;
  readonly root: string;

  private constructor(
    workspaceRoot: string,
    root: string,
    private readonly onWarning?: (message: string) => void,
  ) {
    this.workspaceRoot = workspaceRoot;
    this.root = root;
  }

  static async open(input: {
    workspaceRoot: string;
    onWarning?: (message: string) => void;
    homeRoot?: string;
  }): Promise<ImageAssetStore> {
    const workspaceRoot = await realpath(input.workspaceRoot);
    const workspaceStat = await stat(workspaceRoot);
    if (!workspaceStat.isDirectory()) {
      throw new Error(`Workspace root is not a directory: ${workspaceRoot}.`);
    }
    const storageRoot = workspaceStorageRoot(
      workspaceRoot,
      await canonicalHomeRoot(input.homeRoot),
    );
    const root = await ensureAssetRoot(storageRoot);
    const store = new ImageAssetStore(workspaceRoot, root, input.onWarning);
    await store.cleanupStagingFiles();
    return store;
  }

  pathFor(assetId: ImageAssetId): string {
    parseImageAssetId(assetId);
    return path.join(this.root, assetId);
  }

  async importWorkspaceFile(
    sourcePath: string,
    options: {
      signal?: AbortSignal;
      accept?: (asset: ImageAssetRef) => void;
    } = {},
  ): Promise<ImportedImageAsset> {
    return this.importFileInternal(sourcePath, true, options);
  }

  async importFile(
    sourcePath: string,
    options: {
      signal?: AbortSignal;
    } = {},
  ): Promise<ImportedImageAsset> {
    return this.importFileInternal(sourcePath, false, options);
  }

  private async importFileInternal(
    sourcePath: string,
    workspaceOnly: boolean,
    options: {
      signal?: AbortSignal;
      accept?: (asset: ImageAssetRef) => void;
    },
  ): Promise<ImportedImageAsset> {
    throwIfAborted(options.signal);
    if (typeof sourcePath !== "string" || sourcePath.trim() === "") {
      throw new Error("Image source path must be a non-empty string.");
    }
    const candidate = path.isAbsolute(sourcePath)
      ? path.normalize(sourcePath)
      : path.resolve(this.workspaceRoot, sourcePath);
    if (workspaceOnly || !path.isAbsolute(sourcePath)) {
      assertContained(this.workspaceRoot, candidate, "Image source path");
    }
    const pathStat = await lstat(candidate);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw new Error("Image source must be a regular non-symlink file.");
    }
    const canonicalSource = await realpath(candidate);
    if (workspaceOnly || !path.isAbsolute(sourcePath)) {
      assertContained(this.workspaceRoot, canonicalSource, "Image source realpath");
    }

    const handle = await open(canonicalSource, constants.O_RDONLY | noFollowFlag());
    let bytes: Buffer;
    try {
      const handleStat = await handle.stat();
      if (
        !handleStat.isFile() ||
        handleStat.dev !== pathStat.dev ||
        handleStat.ino !== pathStat.ino
      ) {
        throw new Error("Image source changed between path validation and open.");
      }
      if (handleStat.size < 1) {
        throw new Error("Image source is empty.");
      }
      if (handleStat.size > IMAGE_INPUT_POLICY.maxBytesPerImage) {
        throw new Error(
          `Image is ${handleStat.size} bytes; maximum is ${IMAGE_INPUT_POLICY.maxBytesPerImage}.`,
        );
      }
      bytes = await handle.readFile(
        options.signal === undefined ? undefined : { signal: options.signal },
      );
    } finally {
      await handle.close();
    }
    throwIfAborted(options.signal);

    const asset = await probeImageBytes(bytes, {
      fullDecode: true,
      sourceName: path.basename(canonicalSource),
    });
    options.accept?.(asset);
    throwIfAborted(options.signal);
    await this.publish(asset, bytes, options.signal);
    return Object.freeze({
      asset,
      originalName: normalizeOriginalImageName(path.basename(canonicalSource)),
    });
  }

  async readVerified(
    expected: ImageAssetRef,
    options: { signal?: AbortSignal } = {},
  ): Promise<Buffer> {
    validateImageAssetRef(expected);
    throwIfAborted(options.signal);
    const assetPath = this.pathFor(expected.assetId);
    const fileStat = await lstat(assetPath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new Error(`Image asset ${shortAssetId(expected.assetId)} is not regular.`);
    }
    if (fileStat.size !== expected.byteLength) {
      throw new Error(`Image asset ${shortAssetId(expected.assetId)} length changed.`);
    }
    const handle = await open(assetPath, constants.O_RDONLY | noFollowFlag());
    let bytes: Buffer;
    try {
      const openedStat = await handle.stat();
      if (
        !openedStat.isFile() ||
        openedStat.dev !== fileStat.dev ||
        openedStat.ino !== fileStat.ino
      ) {
        throw new Error(`Image asset ${shortAssetId(expected.assetId)} changed.`);
      }
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    throwIfAborted(options.signal);
    const actual = await probeImageBytes(bytes, { fullDecode: false });
    if (
      actual.assetId !== expected.assetId ||
      actual.mimeType !== expected.mimeType ||
      actual.byteLength !== expected.byteLength ||
      actual.width !== expected.width ||
      actual.height !== expected.height
    ) {
      throw new Error(
        `Image asset ${shortAssetId(expected.assetId)} failed integrity validation.`,
      );
    }
    return bytes;
  }

  async verify(expected: ImageAssetRef): Promise<void> {
    await this.readVerified(expected);
  }

  private async publish(
    asset: ImageAssetRef,
    bytes: Buffer,
    signal?: AbortSignal,
  ): Promise<void> {
    const target = this.pathFor(asset.assetId);
    const staging = path.join(this.root, `.staging-image-${createUuidV7()}`);
    let stagingExists = false;
    try {
      const stagingHandle = await open(staging, "wx", 0o600);
      stagingExists = true;
      try {
        await stagingHandle.writeFile(bytes);
        await stagingHandle.sync();
      } finally {
        await stagingHandle.close();
      }
      throwIfAborted(signal);
      try {
        await link(staging, target);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) {
          throw error;
        }
        await this.verify(asset);
        return;
      }
      await chmod(target, 0o600);
      await syncDirectory(this.root);
    } finally {
      if (stagingExists) {
        await rm(staging).catch((error) => {
          if (!hasCode(error, "ENOENT")) {
            this.onWarning?.(
              `Failed to remove image staging file: ${errorMessage(error)}`,
            );
          }
        });
      }
    }
  }

  private async cleanupStagingFiles(): Promise<void> {
    const names = await readdir(this.root);
    const now = Date.now();
    for (const name of names) {
      if (!STAGING_PATTERN.test(name)) {
        continue;
      }
      const stagingPath = path.join(this.root, name);
      try {
        const entry = await lstat(stagingPath);
        const age = now - entry.mtimeMs;
        if (!Number.isFinite(age) || age < 0) {
          this.onWarning?.(`Image staging file has an invalid mtime: ${name}`);
          continue;
        }
        if (!entry.isFile() || entry.isSymbolicLink() || age <= STAGING_MAX_AGE_MS) {
          continue;
        }
        await rm(stagingPath);
      } catch (error) {
        if (!hasCode(error, "ENOENT")) {
          this.onWarning?.(
            `Image staging cleanup skipped ${name}: ${errorMessage(error)}`,
          );
        }
      }
    }
  }
}

async function ensureAssetRoot(storageRoot: string): Promise<string> {
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const storageEntry = await lstat(storageRoot);
  if (storageEntry.isSymbolicLink() || !storageEntry.isDirectory()) {
    throw new Error(
      `Workspace storage root is not a regular directory: ${storageRoot}.`,
    );
  }
  await chmod(storageRoot, 0o700);

  let current = storageRoot;
  for (const name of ["assets", "images"]) {
    current = path.join(current, name);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(
          `Image asset directory is not a regular directory: ${current}.`,
        );
      }
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        throw error;
      }
      await mkdir(current, { mode: 0o700 });
    }
    await chmod(current, 0o700);
  }
  const canonical = await realpath(current);
  assertContained(storageRoot, canonical, "Image asset root");
  if (canonical !== current) {
    throw new Error("Image asset root is not canonical.");
  }
  return canonical;
}

function assertContained(root: string, candidate: string, name: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  ) {
    return;
  }
  throw new Error(`${name} is outside the workspace.`);
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function shortAssetId(assetId: ImageAssetId): string {
  return `${assetId.slice(0, 12)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
