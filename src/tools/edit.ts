import path from "node:path";
import { Buffer } from "node:buffer";
import { readFile, stat, writeFile } from "node:fs/promises";
import { throwIfTurnCancelled } from "../agent/turn-cancellation";
import { computeFilePatch } from "./file-diff";
import { sha256Text } from "./hash";
import { resolveWorkspacePath } from "./path-safety";
import { defineToolExecutor } from "./types";
import type {
  EditFileRawResult,
  ReadSnapshotStore,
  ToolExecutionContext,
  ToolExecutor,
} from "./types";

type EditArgs = {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all: boolean;
};

export type EditToolOptions = {
  workspaceRoot: string;
  snapshots: ReadSnapshotStore;
};

export function createEditToolExecutor(options: EditToolOptions): ToolExecutor {
  return defineToolExecutor("edit", {
    definition: {
      name: "Edit",
      description:
        "Replace an exact string in a workspace file. The full file must be read first.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          file_path: {
            type: "string",
            description: "Workspace-relative path or absolute path.",
          },
          old_string: {
            type: "string",
            description: "Exact text to replace.",
          },
          new_string: {
            type: "string",
            description: "Replacement text.",
          },
          replace_all: {
            type: "boolean",
            description: "Replace every occurrence when true.",
          },
        },
        required: ["file_path", "old_string", "new_string"],
      },
    },
    async execute(
      args,
      _call,
      context: ToolExecutionContext,
    ): Promise<EditFileRawResult> {
      throwIfTurnCancelled(context.signal);
      const parsed = parseEditArgs(args);

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
        return {
          ok: false,
          filePath: input.file_path,
          error: errorMessage(error),
        };
      }

      const parentPath = path.dirname(absolutePath);
      const parentCheck = await directoryExists(parentPath);
      if (!parentCheck.ok) {
        return {
          ok: false,
          filePath: input.file_path,
          absolutePath,
          error: parentCheck.error,
        };
      }

      const target = await targetFileState(absolutePath);
      if (!target.ok) {
        return {
          ok: false,
          filePath: input.file_path,
          absolutePath,
          error: target.error,
        };
      }

      if (input.old_string === "") {
        return await writeEmptyTarget({
          filePath: input.file_path,
          absolutePath,
          target,
          newContent: input.new_string,
          snapshots: options.snapshots,
          signal: context.signal,
        });
      }

      if (!target.exists) {
        return {
          ok: false,
          filePath: input.file_path,
          absolutePath,
          error: "File does not exist.",
        };
      }

      const snapshot = options.snapshots.get(absolutePath);
      if (snapshot === undefined || snapshot.source === "write" || !snapshot.fullFile) {
        return {
          ok: false,
          filePath: input.file_path,
          absolutePath,
          requiredReadBeforeEdit: true,
          error: "File must be read completely before Edit.",
        };
      }

      if (target.mtimeMs > snapshot.mtimeMs) {
        return {
          ok: false,
          filePath: input.file_path,
          absolutePath,
          currentMtimeMs: target.mtimeMs,
          lastReadMtimeMs: snapshot.mtimeMs,
          error:
            "File changed after the last complete Read. Read it again before Edit.",
        };
      }

      const replacementCount = countMatches(target.content, input.old_string);
      if (replacementCount === 0) {
        return {
          ok: false,
          filePath: input.file_path,
          absolutePath,
          error: "old_string was not found.",
        };
      }

      if (replacementCount > 1 && !input.replace_all) {
        return {
          ok: false,
          filePath: input.file_path,
          absolutePath,
          replacementCount,
          error: "old_string matched multiple locations. Use replace_all=true.",
        };
      }

      const nextContent = input.replace_all
        ? target.content.replaceAll(input.old_string, input.new_string)
        : target.content.replace(input.old_string, input.new_string);

      return await writeEditedContent({
        filePath: input.file_path,
        absolutePath,
        oldSha256: target.sha256,
        oldContent: target.content,
        newContent: nextContent,
        replacementCount: input.replace_all ? replacementCount : 1,
        replaceAll: input.replace_all,
        created: false,
        snapshots: options.snapshots,
        signal: context.signal,
      });
    },
  });
}

function parseEditArgs(
  args: unknown,
): { ok: true; value: EditArgs } | { ok: false; error: string } {
  if (!isRecord(args)) {
    return { ok: false, error: "Edit arguments must be an object." };
  }

  if (typeof args.file_path !== "string") {
    return { ok: false, error: "Edit.file_path must be a string." };
  }

  if (typeof args.old_string !== "string") {
    return { ok: false, error: "Edit.old_string must be a string." };
  }

  if (typeof args.new_string !== "string") {
    return { ok: false, error: "Edit.new_string must be a string." };
  }

  if (args.replace_all !== undefined && typeof args.replace_all !== "boolean") {
    return { ok: false, error: "Edit.replace_all must be a boolean." };
  }

  return {
    ok: true,
    value: {
      file_path: args.file_path,
      old_string: args.old_string,
      new_string: args.new_string,
      replace_all: args.replace_all ?? false,
    },
  };
}

async function writeEmptyTarget(input: {
  filePath: string;
  absolutePath: string;
  target: TargetFileState;
  newContent: string;
  snapshots: ReadSnapshotStore;
  signal: AbortSignal;
}): Promise<EditFileRawResult> {
  if (input.target.exists && input.target.content.length > 0) {
    return {
      ok: false,
      filePath: input.filePath,
      absolutePath: input.absolutePath,
      error: "old_string='' can only create a file or write to an empty file.",
    };
  }

  return await writeEditedContent({
    filePath: input.filePath,
    absolutePath: input.absolutePath,
    oldSha256: input.target.exists ? input.target.sha256 : null,
    oldContent: "",
    newContent: input.newContent,
    replacementCount: 0,
    replaceAll: false,
    created: !input.target.exists,
    snapshots: input.snapshots,
    signal: input.signal,
  });
}

async function writeEditedContent(input: {
  filePath: string;
  absolutePath: string;
  oldSha256: string | null;
  oldContent: string;
  newContent: string;
  replacementCount: number;
  replaceAll: boolean;
  created: boolean;
  snapshots: ReadSnapshotStore;
  signal: AbortSignal;
}): Promise<EditFileRawResult> {
  throwIfTurnCancelled(input.signal);
  await writeFile(input.absolutePath, input.newContent, "utf8");
  const newSha256 = sha256Text(input.newContent);
  const writtenInfo = await stat(input.absolutePath);
  input.snapshots.set(input.absolutePath, {
    sha256: newSha256,
    mtimeMs: writtenInfo.mtimeMs,
    fullFile: true,
    source: "edit",
  });

  const patch = computeFilePatch({
    filePath: input.filePath,
    oldContent: input.oldContent,
    newContent: input.newContent,
  });

  return {
    ok: true,
    filePath: input.filePath,
    absolutePath: input.absolutePath,
    bytesWritten: Buffer.byteLength(input.newContent, "utf8"),
    oldSha256: input.oldSha256,
    newSha256,
    replacementCount: input.replacementCount,
    replaceAll: input.replaceAll,
    created: input.created,
    patch: patch.hunks,
    patchTruncated: patch.truncated,
  };
}

async function directoryExists(
  directoryPath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const info = await stat(directoryPath);
    return info.isDirectory()
      ? { ok: true }
      : { ok: false, error: "Parent path is not a directory." };
  } catch {
    return { ok: false, error: "Parent directory does not exist." };
  }
}

type TargetFileState =
  | { ok: true; exists: false }
  | {
      ok: true;
      exists: true;
      content: string;
      sha256: string;
      mtimeMs: number;
    };

async function targetFileState(
  absolutePath: string,
): Promise<TargetFileState | { ok: false; error: string }> {
  try {
    const info = await stat(absolutePath);
    if (!info.isFile()) {
      return { ok: false, error: "Path is not a file." };
    }

    const content = await readFile(absolutePath, "utf8");
    return {
      ok: true,
      exists: true,
      content,
      sha256: sha256Text(content),
      mtimeMs: info.mtimeMs,
    };
  } catch (error) {
    if (isNotFound(error)) {
      return { ok: true, exists: false };
    }

    return { ok: false, error: errorMessage(error) };
  }
}

function countMatches(content: string, oldString: string): number {
  let count = 0;
  let index = content.indexOf(oldString);

  while (index !== -1) {
    count += 1;
    index = content.indexOf(oldString, index + oldString.length);
  }

  return count;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
