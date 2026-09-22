import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { IMAGE_INPUT_POLICY } from "../image/image-input-policy";
import { probeImageBytes } from "../image/image-probe";
import type { ImportedImageAsset } from "../image/image-asset-store";
import type { ImageAssetRef } from "../image/image-types";
import type { RemoteClient } from "../remote/client";

/** Relative @-mentions name service workspace files; absolute paths name client files. */
export class RemoteImages {
  constructor(
    private readonly transport: RemoteClient,
    private readonly sessionId: string,
    private readonly lifetime: AbortSignal,
  ) {}
  async import(
    sourcePath: string,
    signal: AbortSignal,
    count: number,
  ): Promise<ImportedImageAsset> {
    const combined = AbortSignal.any([signal, this.lifetime]);
    combined.throwIfAborted();
    if (!path.isAbsolute(sourcePath))
      return this.transport.request(
        `/v1/sessions/${this.sessionId}/images`,
        { sourcePath, count },
        combined,
      );
    const stat = await lstat(sourcePath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size < 1 ||
      stat.size > IMAGE_INPUT_POLICY.maxBytesPerImage
    )
      throw new Error(
        "Image must be a regular non-symlink file within the image size limit.",
      );
    const file = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const opened = await file.stat();
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || !opened.isFile())
        throw new Error("Image file changed while opening.");
      // A bounded read also protects against a file growing after stat().
      bytes = Buffer.alloc(IMAGE_INPUT_POLICY.maxBytesPerImage + 1);
      let used = 0;
      while (used < bytes.length) {
        combined.throwIfAborted();
        const read = await file.read(bytes, used, bytes.length - used, used);
        if (read.bytesRead === 0) break;
        used += read.bytesRead;
      }
      bytes = bytes.subarray(0, used);
    } finally {
      await file.close();
    }
    await probeImageBytes(bytes, {
      fullDecode: true,
      sourceName: path.basename(sourcePath),
    });
    return this.transport.request(
      `/v1/sessions/${this.sessionId}/images`,
      {
        bytes: bytes.toString("base64"),
        originalName: path.basename(sourcePath),
        count,
      },
      combined,
    );
  }
  async verify(assets: readonly ImageAssetRef[], signal: AbortSignal): Promise<void> {
    await this.transport.request(
      `/v1/sessions/${this.sessionId}/verify-images`,
      { assets },
      AbortSignal.any([signal, this.lifetime]),
    );
  }
}
