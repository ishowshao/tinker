import { execFile } from "node:child_process";
import { RIPGREP_MISSING_ERROR, findRipgrepCommand } from "../tools/ripgrep";
import { DEFAULT_PUBLIC_TOOLING_CONFIG } from "../cli/public-config-contract";

export type WorkspaceFileLister = (
  workspaceRoot: string,
  signal: AbortSignal,
) => Promise<readonly string[]>;

export type WorkspaceFileListerOptions = {
  readonly command?: string;
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
};

export function createWorkspaceFileLister(
  options: WorkspaceFileListerOptions = {},
): WorkspaceFileLister {
  const command = findRipgrepCommand(options.command);
  const timeoutMs = options.timeoutMs ?? DEFAULT_PUBLIC_TOOLING_CONFIG.grepTimeoutMs;
  const maxBufferBytes =
    options.maxBufferBytes ?? DEFAULT_PUBLIC_TOOLING_CONFIG.grepMaxBufferBytes;

  return (workspaceRoot, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Workspace file search was cancelled."));
        return;
      }

      execFile(
        command,
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
          maxBuffer: maxBufferBytes,
          signal,
          timeout: timeoutMs,
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
            reject(new Error(`Workspace file search timed out after ${timeoutMs}ms.`));
            return;
          }

          if (execError.message.includes("maxBuffer")) {
            reject(new Error(`Workspace file list exceeded ${maxBufferBytes} bytes.`));
            return;
          }

          const detail = stderr.trim() === "" ? execError.message : stderr.trim();
          reject(new Error(`Workspace file search failed: ${detail}`));
        },
      );
    });
}

export const listWorkspaceFiles = createWorkspaceFileLister();

function splitPaths(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line) => line !== "");
}
