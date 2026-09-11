export const MEMORY_CREATE_TOOL_NAME = "MemoryCreate" as const;
export const MAX_MEMORY_TEXT_BYTES = 512;
export const MAX_MEMORY_SUMMARY_BYTES = 4_096;

export type StoredMemorySummary = {
  readonly memoryId: string;
  readonly text: string;
  readonly summary: string;
  readonly sourceWorkspace: string;
  readonly sourceSessionId: string;
  readonly createdAt: string;
};

export function boundedMemoryError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const singleLine = raw.replaceAll(/\s+/g, " ").trim() || "unknown memory error";
  return truncateUtf8(singleLine, 400);
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(`${value.slice(0, end)}…`, "utf8") > maxBytes) {
    end -= 1;
  }
  return `${value.slice(0, end)}…`;
}
