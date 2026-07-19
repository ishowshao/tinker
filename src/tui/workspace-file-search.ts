import { execFile } from "node:child_process";
import { RIPGREP_MISSING_ERROR, findRipgrepCommand } from "../tools/ripgrep";

const FILE_SEARCH_TIMEOUT_MS = 20_000;
const FILE_SEARCH_MAX_BUFFER_BYTES = 20_000_000;

export type WorkspaceFileLister = (
  workspaceRoot: string,
  signal: AbortSignal,
) => Promise<readonly string[]>;

export const listWorkspaceFiles: WorkspaceFileLister = (workspaceRoot, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Workspace file search was cancelled."));
      return;
    }

    execFile(
      findRipgrepCommand(),
      [
        "--files",
        "--hidden",
        "--glob",
        "!**/node_modules/**",
        "--glob",
        "!**/.git/**",
        "--glob",
        "!**/.tinker/**",
      ],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        maxBuffer: FILE_SEARCH_MAX_BUFFER_BYTES,
        signal,
        timeout: FILE_SEARCH_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (signal.aborted) {
          reject(error ?? new Error("Workspace file search was cancelled."));
          return;
        }

        if (error === null) {
          resolve(splitPaths(stdout));
          return;
        }

        const execError = error as Error & {
          code?: number | string;
          killed?: boolean;
          signal?: string | null;
        };

        if (execError.code === 1 && stderr.trim() === "") {
          resolve(splitPaths(stdout));
          return;
        }

        if (execError.code === "ENOENT") {
          reject(new Error(RIPGREP_MISSING_ERROR));
          return;
        }

        if (execError.killed === true || typeof execError.signal === "string") {
          reject(
            new Error(
              `Workspace file search timed out after ${FILE_SEARCH_TIMEOUT_MS}ms.`,
            ),
          );
          return;
        }

        if (execError.message.includes("maxBuffer")) {
          reject(
            new Error(
              `Workspace file list exceeded ${FILE_SEARCH_MAX_BUFFER_BYTES} bytes.`,
            ),
          );
          return;
        }

        const detail = stderr.trim() === "" ? execError.message : stderr.trim();
        reject(new Error(`Workspace file search failed: ${detail}`));
      },
    );
  });

function splitPaths(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line) => line !== "");
}
