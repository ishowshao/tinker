import { readFile, stat, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { throwIfTurnCancelled } from "../agent/turn-cancellation";
import { computeFilePatch } from "./file-diff";
import { ensureParentDirectory } from "./ensure-parent-directory";
import { sha256Bytes, sha256Text } from "./hash";
import { resolveWorkspacePath } from "./path-safety";
import type { TurnUndoManager } from "./turn-undo-manager";
import { defineToolExecutor } from "./types";
import type {
  FileSnapshotStore,
  ToolExecutionContext,
  ToolExecutor,
  WriteFileRawResult,
} from "./types";

type WriteArgs = {
  file_path: string;
  content: string;
};

export type WriteToolOptions = {
  workspaceRoot: string;
  snapshots: FileSnapshotStore;
  undoManager?: TurnUndoManager;
};

export function createWriteToolExecutor(options: WriteToolOptions): ToolExecutor {
  return defineToolExecutor("write", {
    definition: {
      name: "Write",
      description:
        "Write full file content. Missing parent directories are created automatically. Existing files must be read first.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          file_path: {
            type: "string",
            description: "Workspace-relative path or absolute path.",
          },
          content: {
            type: "string",
            description: "The full content to write to the file.",
          },
        },
        required: ["file_path", "content"],
      },
    },
    async execute(
      args,
      call,
      context: ToolExecutionContext,
    ): Promise<WriteFileRawResult> {
      throwIfTurnCancelled(context.signal);
      const parsed = parseWriteArgs(args);

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

      const target = await targetFileState(absolutePath);
      if (!target.ok) {
        return {
          ok: false,
          filePath: input.file_path,
          absolutePath,
          error: target.error,
        };
      }

      let oldSha256: string | null = null;
      let oldContent = "";

      if (target.exists) {
        const currentSha256 = target.sha256;
        const lastSnapshot = options.snapshots.get(absolutePath);

        if (lastSnapshot === undefined) {
          return {
            ok: false,
            filePath: input.file_path,
            absolutePath,
            requiredReadBeforeWrite: true,
            currentSha256,
            error: "Existing file must be read before Write.",
          };
        }

        if (lastSnapshot.sha256 !== currentSha256) {
          return {
            ok: false,
            filePath: input.file_path,
            absolutePath,
            currentSha256,
            lastObservedSha256: lastSnapshot.sha256,
            error:
              "File changed after it was last observed. Read it again before Write.",
          };
        }

        oldSha256 = currentSha256;
        oldContent = target.content;
      }

      const undoCapture = await options.undoManager?.captureBeforeMutation({
        turnId: call.turnId,
        turnNumber: call.turnNumber,
        absolutePath,
        displayPath: input.file_path,
        loadBefore: async () =>
          target.exists
            ? { state: "present", bytes: target.bytes }
            : { state: "absent" },
      });

      throwIfTurnCancelled(context.signal);
      try {
        await ensureParentDirectory(absolutePath);
      } catch (error) {
        if (undoCapture !== undefined) {
          await options.undoManager?.recordMutationFailure(undoCapture);
        }
        return {
          ok: false,
          filePath: input.file_path,
          absolutePath,
          error: `Failed to create parent directory: ${errorMessage(error)}`,
        };
      }
      let newSha256: string;
      try {
        throwIfTurnCancelled(context.signal);
        await writeFile(absolutePath, input.content, "utf8");
        const expectedSha256 = sha256Text(input.content);
        const written = await targetFileState(absolutePath);
        if (!written.ok) {
          throw new Error(`Failed to verify written file: ${written.error}`);
        }
        if (!written.exists) {
          throw new Error("Failed to verify written file: File does not exist.");
        }
        if (written.sha256 !== expectedSha256) {
          throw new Error("File changed while Write was being verified.");
        }
        newSha256 = written.sha256;
        if (undoCapture !== undefined) {
          options.undoManager?.recordMutationResult(undoCapture, {
            state: "present",
            sha256: newSha256,
          });
        }
        options.snapshots.set(absolutePath, {
          sha256: newSha256,
          mtimeMs: written.mtimeMs,
          source: "write",
        });
      } catch (error) {
        if (undoCapture !== undefined) {
          await options.undoManager?.recordMutationFailure(undoCapture);
        }
        throw error;
      }

      const patch = computeFilePatch({
        filePath: input.file_path,
        oldContent,
        newContent: input.content,
      });

      return {
        ok: true,
        filePath: input.file_path,
        absolutePath,
        bytesWritten: Buffer.byteLength(input.content, "utf8"),
        oldSha256,
        newSha256,
        created: !target.exists,
        patch: patch.hunks,
        patchTruncated: patch.truncated,
      };
    },
  });
}

function parseWriteArgs(
  args: unknown,
): { ok: true; value: WriteArgs } | { ok: false; error: string } {
  if (!isRecord(args)) {
    return { ok: false, error: "Write arguments must be an object." };
  }

  if (typeof args.file_path !== "string") {
    return { ok: false, error: "Write.file_path must be a string." };
  }

  if (typeof args.content !== "string") {
    return { ok: false, error: "Write.content must be a string." };
  }

  return {
    ok: true,
    value: {
      file_path: args.file_path,
      content: args.content,
    },
  };
}

async function targetFileState(absolutePath: string): Promise<
  | { ok: true; exists: false }
  | {
      ok: true;
      exists: true;
      sha256: string;
      content: string;
      bytes: Buffer;
      mtimeMs: number;
    }
  | { ok: false; error: string }
> {
  try {
    const info = await stat(absolutePath);
    if (!info.isFile()) {
      return { ok: false, error: "Path is not a file." };
    }

    const bytes = await readFile(absolutePath);
    const currentInfo = await stat(absolutePath);
    if (currentInfo.mtimeMs > info.mtimeMs) {
      return { ok: false, error: "File changed while it was being read." };
    }
    return {
      ok: true,
      exists: true,
      sha256: sha256Bytes(bytes),
      content: bytes.toString("utf8"),
      bytes,
      mtimeMs: currentInfo.mtimeMs,
    };
  } catch (error) {
    if (isNotFound(error)) {
      return { ok: true, exists: false };
    }

    return { ok: false, error: errorMessage(error) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  // ENOTDIR means a parent component is a file, so the target file cannot exist.
  // Treat it as missing here so parent creation reports the underlying path error.
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
