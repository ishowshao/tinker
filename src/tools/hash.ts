import { createHash } from "node:crypto";

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Text(content: string): string {
  return sha256Bytes(Buffer.from(content, "utf8"));
}
