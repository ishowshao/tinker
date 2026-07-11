import { readFile, stat } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { cancellationError, throwIfTurnCancelled } from "../agent/turn-cancellation";
import { sha256Bytes } from "./hash";
import { resolveWorkspacePath } from "./path-safety";
import { defineToolExecutor } from "./types";
import type {
  ReadFileRawResult,
  ReadSnapshotStore,
  ToolExecutionContext,
  ToolExecutor,
} from "./types";

type ReadArgs = {
  file_path: string;
  offset?: number;
  limit?: number;
};

export type ReadToolOptions = {
  workspaceRoot: string;
  snapshots: ReadSnapshotStore;
  maxDisplayedBytes?: number;
};

const defaultMaxDisplayedBytes = 20_000;

export function createReadToolExecutor(options: ReadToolOptions): ToolExecutor {
  const maxDisplayedBytes = options.maxDisplayedBytes ?? defaultMaxDisplayedBytes;

  return defineToolExecutor("read", {
    definition: {
      name: "Read",
      description:
        "Read a file from the local workspace. Use offset and limit for line ranges.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          file_path: {
            type: "string",
            description: "Workspace-relative path or absolute path.",
          },
          offset: {
            type: "integer",
            minimum: 1,
            description: "1-based line number to start reading from.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            description: "Maximum number of lines to read.",
          },
        },
        required: ["file_path"],
      },
    },
    async execute(
      args,
      _call,
      context: ToolExecutionContext,
    ): Promise<ReadFileRawResult> {
      throwIfTurnCancelled(context.signal);
      const parsed = parseReadArgs(args);

      if (!parsed.ok) {
        return {
          ok: false,
          filePath: "",
          error: parsed.error,
        };
      }

      const input = parsed.value;
      let absolutePath: string;

      try {
        absolutePath = resolveWorkspacePath(options.workspaceRoot, input.file_path);
      } catch (error) {
        if (context.signal.aborted) {
          throw cancellationError(context.signal, error);
        }

        return {
          ok: false,
          filePath: input.file_path,
          error: errorMessage(error),
        };
      }

      try {
        const info = await stat(absolutePath);
        throwIfTurnCancelled(context.signal);

        if (!info.isFile()) {
          return {
            ok: false,
            filePath: input.file_path,
            absolutePath,
            error: "Path is not a file.",
          };
        }

        const bytes = await readFile(absolutePath);
        throwIfTurnCancelled(context.signal);
        const sha256 = sha256Bytes(bytes);
        const text = bytes.toString("utf8");
        const lines = splitLines(text);
        const offset = input.offset ?? 1;
        const startIndex = offset - 1;
        const selectedLines = lines.slice(
          startIndex,
          input.limit === undefined ? undefined : startIndex + input.limit,
        );
        const selectedText = selectedLines.join("\n");
        const displayed = truncateUtf8(selectedText, maxDisplayedBytes);

        options.snapshots.set(absolutePath, {
          sha256,
          mtimeMs: info.mtimeMs,
          fullFile:
            input.offset === undefined &&
            input.limit === undefined &&
            !displayed.truncated,
          source: "read",
        });

        return {
          ok: true,
          filePath: input.file_path,
          absolutePath,
          content: displayed.content,
          sizeBytes: info.size,
          totalLines: lines.length,
          startLine: offset,
          endLine:
            selectedLines.length > 0 ? offset + selectedLines.length - 1 : offset - 1,
          sha256,
          truncated: displayed.truncated,
          displayedBytes: displayed.displayedBytes,
        };
      } catch (error) {
        if (context.signal.aborted) {
          throw cancellationError(context.signal, error);
        }

        return {
          ok: false,
          filePath: input.file_path,
          absolutePath,
          error: errorMessage(error),
        };
      }
    },
  });
}

function parseReadArgs(
  args: unknown,
): { ok: true; value: ReadArgs } | { ok: false; error: string } {
  if (!isRecord(args)) {
    return { ok: false, error: "Read arguments must be an object." };
  }

  if (typeof args.file_path !== "string") {
    return { ok: false, error: "Read.file_path must be a string." };
  }

  const offset = parseOptionalPositiveInteger(args.offset, "Read.offset");
  if (!offset.ok) {
    return offset;
  }

  const limit = parseOptionalPositiveInteger(args.limit, "Read.limit");
  if (!limit.ok) {
    return limit;
  }

  return {
    ok: true,
    value: {
      file_path: args.file_path,
      offset: offset.value,
      limit: limit.value,
    },
  };
}

function parseOptionalPositiveInteger(
  value: unknown,
  name: string,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true };
  }

  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    return { ok: false, error: `${name} must be a positive integer.` };
  }

  return { ok: true, value };
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  const lines = text.split(/\r\n|\n|\r/);
  if (text.endsWith("\n") || text.endsWith("\r")) {
    lines.pop();
  }

  return lines;
}

function truncateUtf8(
  content: string,
  maxBytes: number,
): { content: string; truncated: boolean; displayedBytes: number } {
  const bytes = Buffer.from(content, "utf8");

  if (bytes.length <= maxBytes) {
    return {
      content,
      truncated: false,
      displayedBytes: bytes.length,
    };
  }

  const truncated = bytes.subarray(0, maxBytes).toString("utf8");
  return {
    content: truncated,
    truncated: true,
    displayedBytes: Buffer.byteLength(truncated, "utf8"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
