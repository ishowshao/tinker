import type { ToolCall } from "../agent/types";
import type {
  EditFileRawResult,
  GenericToolRawResult,
  GlobRawResult,
  ReadFileRawResult,
  ToolRawResult,
  WriteFileRawResult,
} from "../tools/types";

export type ToolObservation = {
  content: string;
};

export class ObservationBuilder {
  build(input: { call: ToolCall; raw: ToolRawResult }): ToolObservation {
    if (input.call.name === "Glob") {
      return { content: renderGlobObservation(input.raw as GlobRawResult) };
    }

    if (input.call.name === "Read") {
      return { content: renderReadObservation(input.raw as ReadFileRawResult) };
    }

    if (input.call.name === "Write") {
      return { content: renderWriteObservation(input.raw as WriteFileRawResult) };
    }

    if (input.call.name === "Edit") {
      return { content: renderEditObservation(input.raw as EditFileRawResult) };
    }

    return { content: renderGenericObservation(input.raw as GenericToolRawResult) };
  }
}

function renderGlobObservation(raw: GlobRawResult): string {
  if (!raw.ok) {
    return `Glob failed for pattern=${JSON.stringify(raw.pattern)}: ${raw.error ?? "Unknown error."}`;
  }

  const matches = raw.matches ?? [];

  return [
    `Glob succeeded for pattern=${JSON.stringify(raw.pattern)}.`,
    `searchPath=${raw.searchPath}`,
    `matchCount=${raw.matchCount ?? matches.length}`,
    `ignored=${(raw.ignored ?? []).join(",")}`,
    "matches:",
    matches.length === 0 ? "(no matches)" : matches.join("\n"),
  ].join("\n");
}

function renderReadObservation(raw: ReadFileRawResult): string {
  if (!raw.ok) {
    return `Read failed for ${raw.filePath || "(unknown path)"}: ${raw.error ?? "Unknown error."}`;
  }

  const range =
    raw.startLine !== undefined && raw.endLine !== undefined
      ? `lines ${raw.startLine}-${raw.endLine}`
      : "requested range";
  const truncation = raw.truncated
    ? `\nContent was truncated to ${raw.displayedBytes ?? 0} displayed bytes.`
    : "";

  return [
    `Read succeeded for ${raw.filePath}.`,
    `sha256=${raw.sha256}`,
    `sizeBytes=${raw.sizeBytes ?? 0}`,
    `totalLines=${raw.totalLines ?? 0}`,
    `displayed=${range}${truncation}`,
    "content:",
    raw.content ?? "",
  ].join("\n");
}

function renderWriteObservation(raw: WriteFileRawResult): string {
  if (!raw.ok) {
    const guidance = raw.requiredReadBeforeWrite
      ? " Call Read on this file before trying Write again."
      : "";
    return `Write failed for ${raw.filePath || "(unknown path)"}: ${raw.error ?? "Unknown error."}${guidance}`;
  }

  return [
    `Write succeeded for ${raw.filePath}.`,
    `bytesWritten=${raw.bytesWritten ?? 0}`,
    `oldSha256=${raw.oldSha256 ?? "null"}`,
    `newSha256=${raw.newSha256}`,
  ].join("\n");
}

function renderEditObservation(raw: EditFileRawResult): string {
  if (!raw.ok) {
    const guidance = raw.requiredReadBeforeEdit
      ? " Call Read on the full file before trying Edit again."
      : "";
    return `Edit failed for ${raw.filePath || "(unknown path)"}: ${raw.error ?? "Unknown error."}${guidance}`;
  }

  return [
    `Edit succeeded for ${raw.filePath}.`,
    `bytesWritten=${raw.bytesWritten ?? 0}`,
    `replacementCount=${raw.replacementCount ?? 0}`,
    `replaceAll=${raw.replaceAll ?? false}`,
    `created=${raw.created ?? false}`,
    `oldSha256=${raw.oldSha256 ?? "null"}`,
    `newSha256=${raw.newSha256}`,
  ].join("\n");
}

function renderGenericObservation(raw: GenericToolRawResult): string {
  return `${raw.toolName} failed: ${raw.error}`;
}
