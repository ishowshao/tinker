import { describe, expect, test } from "bun:test";
import { MAX_FRAME_BYTES } from "../src/constants";
import {
  encodeJsonFrame,
  FrameProtocolError,
  JsonFrameDecoder,
} from "../src/frame-codec";

describe("Tinker Chrome frame codec", () => {
  test("decodes fragmented Unicode and multiple frames", () => {
    const first = encodeJsonFrame({ text: "你好 Chrome" });
    const second = encodeJsonFrame({ ok: true });
    const bytes = Buffer.concat([first, second]);
    const decoder = new JsonFrameDecoder();

    expect(decoder.push(bytes.subarray(0, 3))).toEqual([]);
    expect(decoder.push(bytes.subarray(3, first.length + 2))).toEqual([
      { text: "你好 Chrome" },
    ]);
    expect(decoder.push(bytes.subarray(first.length + 2))).toEqual([{ ok: true }]);
    expect(() => decoder.end()).not.toThrow();
  });

  test("rejects zero, oversized, invalid JSON, and partial frames", () => {
    const zero = Buffer.alloc(4);
    expect(() => new JsonFrameDecoder().push(zero)).toThrow(FrameProtocolError);

    const oversized = Buffer.alloc(4);
    oversized.writeUInt32LE(MAX_FRAME_BYTES + 1);
    expect(() => new JsonFrameDecoder().push(oversized)).toThrow(FrameProtocolError);

    const invalid = Buffer.alloc(5);
    invalid.writeUInt32LE(1);
    invalid[4] = "{".charCodeAt(0);
    expect(() => new JsonFrameDecoder().push(invalid)).toThrow(FrameProtocolError);

    const decoder = new JsonFrameDecoder();
    decoder.push(encodeJsonFrame({ value: 1 }).subarray(0, 5));
    expect(() => decoder.end()).toThrow(FrameProtocolError);
  });
});
