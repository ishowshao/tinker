import type { ToolCall } from "../agent/types";
import type {
  BashRawResult,
  DeleteFileRawResult,
  EditFileRawResult,
  GenericToolRawResult,
  GlobRawResult,
  GrepRawResult,
  MemorySearchRawResult,
  McpToolRawResult,
  ReadFileRawResult,
  RecallRawResult,
  SkillRawResult,
  TaskListRawResult,
  TaskOutputRawResult,
  TaskStopRawResult,
  ToolRawResult,
  WebFetchRawResult,
  WebSearchRawResult,
  WriteFileRawResult,
} from "../tools/types";

export type ToolObservation = {
  content: string;
};

export class ObservationBuilder {
  build(input: { call: ToolCall; raw: ToolRawResult }): ToolObservation {
    switch (input.raw.kind) {
      case "glob":
        return { content: renderGlobObservation(input.raw) };
      case "grep":
        return { content: renderGrepObservation(input.raw) };
      case "read":
        return { content: renderReadObservation(input.raw) };
      case "recall":
        return { content: renderRecallObservation(input.raw) };
      case "memory_search":
        return { content: renderMemorySearchObservation(input.raw) };
      case "skill":
        return { content: renderSkillObservation(input.raw) };
      case "write":
        return { content: renderWriteObservation(input.raw) };
      case "edit":
        return { content: renderEditObservation(input.raw) };
      case "delete":
        return { content: renderDeleteObservation(input.raw) };
      case "bash":
        return { content: renderBashObservation(input.raw) };
      case "task_list":
        return { content: renderTaskListObservation(input.raw) };
      case "task_output":
        return { content: renderTaskOutputObservation(input.raw) };
      case "task_stop":
        return { content: renderTaskStopObservation(input.raw) };
      case "web_search":
        return { content: renderWebSearchObservation(input.raw) };
      case "web_fetch":
        return { content: renderWebFetchObservation(input.raw) };
      case "mcp":
        return { content: renderMcpObservation(input.raw) };
      case "generic":
        return { content: renderGenericObservation(input.raw) };
      default:
        return assertNever(input.raw);
    }
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled tool raw result: ${JSON.stringify(value)}`);
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
      : "empty file";

  return [
    `Read succeeded for ${raw.filePath}.`,
    `sha256=${raw.sha256}`,
    `sizeBytes=${raw.sizeBytes ?? 0}`,
    `contentBytes=${raw.contentBytes ?? 0}`,
    `totalLines=${raw.totalLines ?? 0}`,
    `displayed=${range}`,
    "content:",
    raw.content ?? "",
  ].join("\n");
}

function renderRecallObservation(raw: RecallRawResult): string {
  if (!raw.ok) {
    return `Recall ${raw.mode} failed (${raw.errorCode}): ${raw.error}`;
  }
  if (raw.mode === "get") {
    const page = raw.page;
    return [
      "Recall retrieved historical session data.",
      "historical=true",
      `source=${page.source}`,
      `role=${page.role}`,
      page.toolName === undefined ? undefined : `toolName=${page.toolName}`,
      `turnNumber=${page.turnNumber}`,
      `ordinal=${page.ordinal}`,
      `createdAt=${page.createdAt}`,
      `contentSha256=${page.contentSha256}`,
      `totalBytes=${page.totalBytes}`,
      `byteOffset=${page.byteOffset}`,
      `returnedBytes=${page.returnedBytes}`,
      `nextByteOffset=${page.nextByteOffset ?? "null"}`,
      "currentWorkspaceGuidance=Use Read/Grep to verify current files; this content is historical.",
      "content:",
      page.content,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  const page = raw.page;
  const header = [
    "Recall searched historical session data.",
    "historical=true",
    `query=${JSON.stringify(raw.query)}`,
    `strategy=${page.strategy}`,
    `snapshotThroughOrdinal=${page.snapshotThroughOrdinal}`,
    `offset=${page.offset}`,
    `limit=${page.limit}`,
    `nextOffset=${page.nextOffset ?? "null"}`,
    `matchesReturned=${page.hits.length}`,
  ].join("\n");
  if (page.hits.length === 0) {
    return `${header}\n\nNo matches were found in the current session for the supplied query, filters, and search snapshot. This does not prove that the information does not exist.`;
  }
  const hits = page.hits.map((hit, index) =>
    [
      `[${index + 1}]`,
      `source=${hit.source}`,
      `role=${hit.role}`,
      hit.toolName === undefined ? undefined : `toolName=${hit.toolName}`,
      `turnNumber=${hit.turnNumber}`,
      `ordinal=${hit.ordinal}`,
      `createdAt=${hit.createdAt}`,
      `contentSha256=${hit.contentSha256}`,
      "excerpt:",
      hit.excerpt,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n"),
  );
  return [header, ...hits].join("\n\n");
}

function renderMemorySearchObservation(raw: MemorySearchRawResult): string {
  if (!raw.ok) {
    return `MemorySearch unavailable: ${raw.error}`;
  }
  if (raw.matches.length === 0) {
    return "MemorySearch found no stored memories.";
  }
  const header = `MemorySearch returned ${raw.matches.length} derived memories. They may be stale or wrong; verify current workspace facts.`;
  return [
    header,
    ...raw.matches.map(
      (match, index) =>
        `${index + 1}. score=${match.score.toFixed(3)} created_at=${match.createdAt} workspace=${match.sourceWorkspace}\n   ${match.text}`,
    ),
  ].join("\n\n");
}

export function renderSkillObservation(raw: SkillRawResult): string {
  if (!raw.ok) {
    return `Skill failed for ${raw.name || "(unknown skill)"} (${raw.errorCode}): ${raw.error}`;
  }
  if (raw.status === "already_loaded") {
    return `Agent Skill ${raw.name} is already loaded for this turn (lifecycle=${raw.lifecycle}).`;
  }
  if (raw.status === "already_active") {
    return `Agent Skill ${raw.name} is already active in the current system surface.`;
  }

  const content = raw.content + (raw.content.endsWith("\n") ? "" : "\n");
  return `<agent_skill name=${JSON.stringify(raw.name)} scope=${JSON.stringify(raw.scope)}>
Skill directory: ${raw.directory}
Relative paths in this skill resolve from that directory.
Do not modify the skill itself unless the user explicitly asks.

<skill_file>
${content}</skill_file>

<skill_resources truncated=${JSON.stringify(String(raw.resourcesTruncated))}>
${raw.resources.length === 0 ? "(no listed resources)" : raw.resources.join("\n")}
</skill_resources>
</agent_skill>`;
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
      ? " Call Read on this file before trying Edit again."
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

function renderDeleteObservation(raw: DeleteFileRawResult): string {
  if (!raw.ok) {
    return `Delete failed for ${raw.filePath || "(unknown path)"}: ${raw.error ?? "Unknown error."}`;
  }

  return `Delete succeeded for ${raw.filePath}.`;
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

function renderTaskListObservation(raw: TaskListRawResult): string {
  if (!raw.ok) {
    return `TaskList failed: ${raw.error ?? "Unknown error."}`;
  }

  const header = `Background tasks: ${raw.tasks.length} total, ${raw.runningCount} running.`;
  if (raw.tasks.length === 0) {
    return `${header}\n\n(no background tasks)`;
  }

  return [header, ...raw.tasks.map(renderTaskSummary)].join("\n\n");
}

function renderTaskOutputObservation(raw: TaskOutputRawResult): string {
  if (!raw.ok || raw.task === undefined) {
    return `TaskOutput failed for ${raw.taskId || "(unknown task ID)"}: ${raw.error ?? "Unknown error."}`;
  }

  return [
    "Task output retrieved.",
    `taskId=${raw.taskId}`,
    `status=${raw.task.status}`,
    `command=${raw.task.command}`,
    `outputFilePath=${raw.outputFilePath}`,
    `outputBytes=${raw.outputBytes ?? 0}`,
    `outputLines=${raw.outputLines ?? 0}`,
    `truncated=${raw.truncated ?? false}`,
    raw.omittedLines === undefined ? undefined : `omittedLines=${raw.omittedLines}`,
    "preview:",
    raw.preview ?? "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderTaskStopObservation(raw: TaskStopRawResult): string {
  if (!raw.ok || raw.task === undefined) {
    return `TaskStop failed for ${raw.taskId || "(unknown task ID)"}: ${raw.error ?? "Unknown error."}`;
  }

  return [
    "Task stopped.",
    `taskId=${raw.taskId}`,
    `status=${raw.task.status}`,
    raw.task.exitCode === undefined ? undefined : `exitCode=${raw.task.exitCode}`,
    raw.task.signal === undefined ? undefined : `signal=${raw.task.signal}`,
    `escalated=${raw.escalated ?? false}`,
    `endedAt=${raw.task.endedAt}`,
    `outputFilePath=${raw.task.outputFilePath}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderTaskSummary(task: TaskListRawResult["tasks"][number]): string {
  return [
    `taskId=${task.taskId}`,
    `description=${task.description}`,
    `status=${task.status}`,
    `startedAt=${task.startedAt}`,
    task.endedAt === undefined ? undefined : `endedAt=${task.endedAt}`,
    task.exitCode === undefined ? undefined : `exitCode=${task.exitCode}`,
    task.signal === undefined ? undefined : `signal=${task.signal}`,
    task.error === undefined ? undefined : `error=${task.error}`,
    `outputFilePath=${task.outputFilePath}`,
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

function renderWebFetchObservation(raw: WebFetchRawResult): string {
  if (!raw.ok) {
    return `WebFetch failed for ${raw.url || "(unknown url)"}: ${raw.error ?? "Unknown error."}`;
  }

  if (raw.redirectUrl !== undefined) {
    return [
      `WebFetch was redirected to ${raw.redirectUrl}.`,
      "The redirect crosses hosts, so it was not followed automatically.",
      "Call WebFetch again with this URL if the redirect target is expected.",
    ].join("\n");
  }

  const sections = [
    `Web fetch result for ${raw.url} (route=${raw.route ?? "unknown"}, refined=${raw.refined ?? false}):`,
  ];

  if (raw.title !== undefined && raw.title !== "") {
    sections.push(`Title: ${raw.title}`);
  }

  sections.push(raw.content ?? "");

  const highlights = raw.highlights ?? [];
  if (highlights.length > 0) {
    sections.push(
      [
        "Highlights:",
        ...highlights.map((entry) => `- ${collapseWhitespace(entry)}`),
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
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
