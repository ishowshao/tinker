import { lstat, readFile, rm } from "node:fs/promises";
import { throwIfTurnCancelled } from "../agent/turn-cancellation";
import { resolveWorkspacePath } from "./path-safety";
import type { TurnUndoManager } from "./turn-undo-manager";
import { defineToolExecutor } from "./types";
import type {
  DeleteFileRawResult,
  FileSnapshotStore,
  ToolExecutionContext,
  ToolExecutor,
} from "./types";

type DeleteArgs = {
  file_path: string;
};

export type DeleteToolOptions = {
  workspaceRoot: string;
  snapshots: FileSnapshotStore;
  undoManager?: TurnUndoManager;
};

export function createDeleteToolExecutor(options: DeleteToolOptions): ToolExecutor {
  return defineToolExecutor("delete", {
    definition: {
      name: "Delete",
      description:
        "Delete one existing regular file. Directories and symbolic links are not supported.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          file_path: {
            type: "string",
            description: "Workspace-relative path or absolute path.",
          },
        },
        required: ["file_path"],
      },
    },
    async execute(
      args,
      call,
      context: ToolExecutionContext,
    ): Promise<DeleteFileRawResult> {
      throwIfTurnCancelled(context.signal);
      const parsed = parseDeleteArgs(args);

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

      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(absolutePath);
      } catch (error) {
        return {
          ok: false,
          filePath: input.file_path,
          absolutePath,
          error: deleteErrorMessage(error),
        };
      }

      if (info.isSymbolicLink()) {
        return {
          ok: false,
          filePath: input.file_path,
          absolutePath,
          error: "Symbolic links are not supported.",
        };
      }

      if (!info.isFile()) {
        return {
          ok: false,
          filePath: input.file_path,
          absolutePath,
          error: "Path is not a regular file.",
        };
      }

      const undoCapture = await options.undoManager?.captureBeforeMutation({
        turnId: call.turnId,
        turnNumber: call.turnNumber,
        absolutePath,
        displayPath: input.file_path,
        knownByteLength: info.size,
        loadBefore: async () => ({
          state: "present",
          bytes: await readFile(absolutePath),
        }),
      });

      try {
        throwIfTurnCancelled(context.signal);
        await rm(absolutePath);
      } catch (error) {
        if (undoCapture !== undefined) {
          await options.undoManager?.recordMutationFailure(undoCapture);
        }
        if (context.signal.aborted) {
          throw error;
        }
        return {
          ok: false,
          filePath: input.file_path,
          absolutePath,
          error: deleteErrorMessage(error),
        };
      }

      if (undoCapture !== undefined) {
        options.undoManager?.recordMutationResult(undoCapture, { state: "absent" });
      }
      options.snapshots.delete(absolutePath);

      return {
        ok: true,
        filePath: input.file_path,
        absolutePath,
      };
    },
  });
}

function parseDeleteArgs(
  args: unknown,
): { ok: true; value: DeleteArgs } | { ok: false; error: string } {
  if (!isRecord(args)) {
    return { ok: false, error: "Delete arguments must be an object." };
  }

  if (typeof args.file_path !== "string") {
    return { ok: false, error: "Delete.file_path must be a string." };
  }

  return {
    ok: true,
    value: {
      file_path: args.file_path,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deleteErrorMessage(error: unknown): string {
  return isNotFound(error) ? "File does not exist." : errorMessage(error);
}

function isNotFound(error: unknown): boolean {
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
