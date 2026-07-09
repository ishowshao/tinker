import type { ToolCall } from "../agent/types";
import { isMcpToolName } from "../mcp/mcp-tool-executor";
import type {
  BashRawResult,
  EditFileRawResult,
  GenericToolRawResult,
  GlobRawResult,
  GrepRawResult,
  McpToolRawResult,
  ReadFileRawResult,
  ToolRawResult,
  WebSearchRawResult,
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

    if (input.call.name === "Grep") {
      return { content: renderGrepObservation(input.raw as GrepRawResult) };
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

    if (input.call.name === "Bash") {
      return { content: renderBashObservation(input.raw as BashRawResult) };
    }

    if (input.call.name === "WebSearch") {
      return {
        content: renderWebSearchObservation(input.raw as WebSearchRawResult),
      };
    }

    if (isMcpToolName(input.call.name)) {
      return { content: renderMcpObservation(input.raw as McpToolRawResult) };
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

function renderGrepObservation(raw: GrepRawResult): string {
  if (!raw.ok) {
    return `Grep failed for pattern=${JSON.stringify(raw.pattern)}: ${raw.error ?? "Unknown error."}`;
  }

  const sections: string[] = [];

  if (raw.mode === "files_with_matches") {
    sections.push(
      raw.numFiles === 0
        ? "No files found"
        : [
            `Found ${raw.numFiles} file${raw.numFiles === 1 ? "" : "s"}`,
            ...raw.filenames,
          ].join("\n"),
    );
  } else if (raw.mode === "count") {
    if (raw.numFiles === 0) {
      sections.push("No matches found");
    } else {
      sections.push(raw.content ?? "");
      sections.push(
        `Found ${raw.numMatches ?? 0} total occurrence${(raw.numMatches ?? 0) === 1 ? "" : "s"} across ${raw.numFiles} file${raw.numFiles === 1 ? "" : "s"}.`,
      );
    }
  } else {
    sections.push(
      raw.content === undefined || raw.content === ""
        ? "No matches found"
        : raw.content,
    );
  }

  const pagination = renderGrepPagination(raw);
  if (pagination !== undefined) {
    sections.push(pagination);
  }

  if (raw.truncated === true && raw.error !== undefined) {
    sections.push(`Warning: results are incomplete. ${raw.error}`);
  }

  return sections.join("\n\n");
}

function renderGrepPagination(raw: GrepRawResult): string | undefined {
  const parts: string[] = [];

  if (raw.appliedLimit !== undefined) {
    parts.push(`limit: ${raw.appliedLimit}`);
  }

  if (raw.appliedOffset !== undefined) {
    parts.push(`offset: ${raw.appliedOffset}`);
  }

  return parts.length === 0
    ? undefined
    : `[Showing results with pagination = ${parts.join(", ")}]`;
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

function renderBashObservation(raw: BashRawResult): string {
  if (raw.taskId === "" && !raw.ok) {
    return `Bash failed: ${raw.error ?? "Unknown error."}`;
  }

  if (raw.status === "running" && raw.backgroundedDueToTimeout) {
    return [
      "Bash command exceeded foreground timeout and is still running.",
      `taskId=${raw.taskId}`,
      `timeoutMs=${raw.timeoutMs ?? 0}`,
      `command=${raw.command}`,
      `cwd=${raw.cwd}`,
      `outputFilePath=${raw.outputFilePath}`,
      "Use Read on outputFilePath to inspect current output.",
    ].join("\n");
  }

  if (raw.status === "running") {
    return [
      "Bash command is running in background.",
      `taskId=${raw.taskId}`,
      `command=${raw.command}`,
      `cwd=${raw.cwd}`,
      `outputFilePath=${raw.outputFilePath}`,
      "Use Read on outputFilePath to inspect current output.",
    ].join("\n");
  }

  return [
    `Bash ${raw.status}.`,
    `command=${raw.command}`,
    `exitCode=${raw.exitCode ?? "null"}`,
    `status=${raw.status}`,
    `cwd=${raw.cwd}`,
    `outputFilePath=${raw.outputFilePath}`,
    `outputBytes=${raw.outputBytes}`,
    `outputLines=${raw.outputLines}`,
    `truncated=${raw.truncated}`,
    raw.omittedLines === undefined ? undefined : `omittedLines=${raw.omittedLines}`,
    raw.returnCodeInterpretation === undefined
      ? undefined
      : `returnCodeInterpretation=${raw.returnCodeInterpretation}`,
    raw.error === undefined ? undefined : `error=${raw.error}`,
    "preview:",
    raw.preview,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderWebSearchObservation(raw: WebSearchRawResult): string {
  if (!raw.ok) {
    return `WebSearch failed for query=${JSON.stringify(raw.query)}: ${raw.error ?? "Unknown error."}`;
  }

  const results = raw.results ?? [];
  const header = `Web search results for query ${JSON.stringify(raw.query)} (${results.length} result${results.length === 1 ? "" : "s"}):`;

  if (results.length === 0) {
    return `${header}\n\n(no results)`;
  }

  const blocks = results.map((result, index) => {
    const lines = [
      `${index + 1}. ${result.title === "" ? result.url : result.title}`,
      `   URL: ${result.url}`,
    ];

    if (result.publishedDate !== undefined) {
      lines.push(`   Published: ${result.publishedDate}`);
    }

    for (const highlight of result.highlights ?? []) {
      lines.push(`   - ${collapseWhitespace(highlight)}`);
    }

    return lines.join("\n");
  });

  return [header, ...blocks].join("\n\n");
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function renderMcpObservation(raw: McpToolRawResult): string {
  if (!raw.ok && raw.isError !== true) {
    return `${raw.toolName} failed: ${raw.error ?? "Unknown error."}`;
  }

  const text = raw.text ?? "";
  const sections: string[] = [];

  if (raw.isError === true) {
    sections.push(`${raw.toolName} failed (server reported error):`);
  }

  sections.push(
    text.trim() === ""
      ? `(no text content, ${raw.contentBlockCount ?? 0} content block${(raw.contentBlockCount ?? 0) === 1 ? "" : "s"})`
      : text,
  );

  if (raw.truncated === true) {
    sections.push(`[Output truncated to ${text.length} characters.]`);
  }

  return sections.join("\n");
}

function renderGenericObservation(raw: GenericToolRawResult): string {
  return `${raw.toolName} failed: ${raw.error}`;
}
