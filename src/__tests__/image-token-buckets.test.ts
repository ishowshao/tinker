import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import {
  IMAGE_INPUT_POLICY,
  imagePlanningTokens,
  providerImageDimensions,
} from "../image/image-input-policy";
import { materializeProviderImage, orientedDimensions } from "../image/provider-image";

describe("provider image dimensions", () => {
  test("does not enlarge images within the provider limit", () => {
    expect(providerImageDimensions(400, 300)).toEqual({ width: 400, height: 300 });
    expect(providerImageDimensions(2048, 2048)).toEqual({
      width: 2048,
      height: 2048,
    });
  });

  test("downscales landscape, portrait, and square dimensions proportionally", () => {
    expect(providerImageDimensions(4096, 2048)).toEqual({
      width: 2048,
      height: 1024,
    });
    expect(providerImageDimensions(1000, 4000)).toEqual({
      width: 512,
      height: 2048,
    });
    expect(providerImageDimensions(3000, 3000)).toEqual({
      width: 2048,
      height: 2048,
    });
  });

  test("rounding never exceeds the fixed long-edge limit", () => {
    for (const [width, height] of [
      [4095, 2047],
      [2049, 2048],
      [1, 4096],
      [4096, 1],
    ] as const) {
      const target = providerImageDimensions(width, height);
      expect(Math.max(target.width, target.height)).toBeLessThanOrEqual(
        IMAGE_INPUT_POLICY.maxProviderLongEdge,
      );
    }
  });

  test("uses visual dimensions after EXIF rotation", () => {
    expect(orientedDimensions(1200, 800, 6)).toEqual({ width: 800, height: 1200 });
    expect(orientedDimensions(1200, 800, 1)).toEqual({ width: 1200, height: 800 });
  });
});

describe("image token buckets", () => {
  test("rounds long-edge boundaries up into four conservative buckets", () => {
    expect(imagePlanningTokens(512, 1)).toBe(384);
    expect(imagePlanningTokens(513, 1)).toBe(1408);
    expect(imagePlanningTokens(1024, 1)).toBe(1408);
    expect(imagePlanningTokens(1025, 1)).toBe(3072);
    expect(imagePlanningTokens(1536, 1)).toBe(3072);
    expect(imagePlanningTokens(1537, 1)).toBe(5504);
    expect(imagePlanningTokens(2048, 1)).toBe(5504);
    expect(() => imagePlanningTokens(2049, 1)).toThrow(
      "exceeds the provider image size policy",
    );
  });

  test("uses the long-edge square upper bound for extreme aspect ratios", () => {
    expect(imagePlanningTokens(2048, 512)).toBe(5504);
    expect(imagePlanningTokens(512, 2048)).toBe(5504);
  });
});

describe("provider image materialization", () => {
  test("preserves small image bytes and dimensions", async () => {
    const bytes = await solidPng(400, 300);
    const image = await materializeProviderImage(bytes, "image/png");
    expect(image.bytes).toEqual(bytes);
    expect(image).toMatchObject({ width: 400, height: 300, planningTokens: 384 });
  });

  test("downscales a real image to the provider limit", async () => {
    const bytes = await solidPng(3000, 1000);
    const image = await materializeProviderImage(bytes, "image/png");
    expect(image.width).toBe(2048);
    expect(image.height).toBe(683);
    expect(image.planningTokens).toBe(5504);
    expect(Math.max(image.width, image.height)).toBe(2048);
  });

  test("normalizes EXIF orientation before selecting the bucket", async () => {
    const bytes = await sharp({
      create: {
        width: 800,
        height: 1200,
        channels: 3,
        background: "#445566",
      },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const image = await materializeProviderImage(bytes, "image/jpeg");
    expect(image).toMatchObject({ width: 1200, height: 800, planningTokens: 3072 });
  });
});

async function solidPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "#123456",
    },
  })
    .png()
    .toBuffer();
}
