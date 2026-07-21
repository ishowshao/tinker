import { MAX_FRAME_BYTES } from "./constants";

export class FrameProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FrameProtocolError";
  }
}

export class JsonFrameDecoder {
  private buffered = Buffer.alloc(0);

  push(chunk: Uint8Array): unknown[] {
    if (chunk.byteLength === 0) {
      return [];
    }

    this.buffered = Buffer.concat([this.buffered, Buffer.from(chunk)]);
    const messages: unknown[] = [];

    while (this.buffered.byteLength >= 4) {
      const frameLength = this.buffered.readUInt32LE(0);
      if (frameLength === 0) {
        throw new FrameProtocolError("Frame length must be greater than zero.");
      }
      if (frameLength > MAX_FRAME_BYTES) {
        throw new FrameProtocolError(
          `Frame length ${frameLength} exceeds ${MAX_FRAME_BYTES} bytes.`,
        );
      }
      if (this.buffered.byteLength < frameLength + 4) {
        break;
      }

      const payload = this.buffered.subarray(4, frameLength + 4);
      this.buffered = this.buffered.subarray(frameLength + 4);

      try {
        messages.push(JSON.parse(payload.toString("utf8")) as unknown);
      } catch (error) {
        throw new FrameProtocolError("Frame payload is not valid JSON.", {
          cause: error,
        });
      }
    }

    return messages;
  }

  end(): void {
    if (this.buffered.byteLength !== 0) {
      throw new FrameProtocolError("Input ended with a partial frame.");
    }
  }
}

export function encodeJsonFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength === 0 || payload.byteLength > MAX_FRAME_BYTES) {
    throw new FrameProtocolError(
      `Encoded payload must be between 1 and ${MAX_FRAME_BYTES} bytes.`,
    );
  }

  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32LE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}
