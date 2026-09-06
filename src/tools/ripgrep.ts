import { execFile } from "node:child_process";
import path from "node:path";
import { cancellationError, throwIfTurnCancelled } from "../agent/turn-cancellation";
import { DEFAULT_PUBLIC_TOOLING_CONFIG } from "../cli/public-config-contract";

export const RIPGREP_MISSING_ERROR =
  "Tinker's bundled ripgrep executable is unavailable. Reinstall tinker-agent.";

export type RipgrepResult = {
  ok: boolean;
  /** Raw stdout; the caller must decode its selected record protocol. */
  stdout: string;
  exitCode?: number;
  truncated: boolean;
  error?: string;
};

export type RipgrepOptions = {
  signal: AbortSignal;
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
};

export function findRipgrepCommand(command?: string): string {
  return command ?? DEFAULT_PUBLIC_TOOLING_CONFIG.ripgrepPath;
}

export async function ripGrep(
  args: string[],
  options: RipgrepOptions,
): Promise<RipgrepResult> {
  throwIfTurnCancelled(options.signal);
  const timeoutMs = options.timeoutMs ?? DEFAULT_PUBLIC_TOOLING_CONFIG.grepTimeoutMs;
  const maxBufferBytes =
    options.maxBufferBytes ?? DEFAULT_PUBLIC_TOOLING_CONFIG.grepMaxBufferBytes;
  const configuredCommand = findRipgrepCommand(options.command);
  // Preserve relative executable paths when only the search subprocess changes cwd.
  const command =
    options.cwd !== undefined &&
    (configuredCommand.includes("/") || configuredCommand.includes(path.sep))
      ? path.resolve(configuredCommand)
      : configuredCommand;

  const first = await runRipgrep(
    command,
    args,
    timeoutMs,
    maxBufferBytes,
    options.signal,
    options.cwd,
  );
  if (first.retryWithSingleThread) {
    throwIfTurnCancelled(options.signal);
    return finalizeResult(
      await runRipgrep(
        command,
        ["-j", "1", ...args],
        timeoutMs,
        maxBufferBytes,
        options.signal,
        options.cwd,
      ),
    );
  }

  return finalizeResult(first);
}

type RipgrepAttempt = {
  ok: boolean;
  stdout: string;
  exitCode?: number;
  truncated: boolean;
  error?: string;
  retryWithSingleThread?: boolean;
};

function runRipgrep(
  command: string,
  args: string[],
  timeoutMs: number,
  maxBufferBytes: number,
  signal: AbortSignal,
  cwd?: string,
): Promise<RipgrepAttempt> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(cancellationError(signal));
      return;
    }

    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: maxBufferBytes, signal, cwd },
      (error, stdout, stderr) => {
        if (signal.aborted) {
          reject(cancellationError(signal, error));
          return;
        }

        if (error === null) {
          resolve({ ok: true, stdout, exitCode: 0, truncated: false });
          return;
        }

        const execError = error as Error & {
          killed?: boolean;
          signal?: string | null;
          code?: number | string;
        };

        if (execError.code === "ENOENT") {
          resolve({
            ok: false,
            stdout: "",
            truncated: false,
            error: RIPGREP_MISSING_ERROR,
          });
          return;
        }

        if (isEagainError(execError, stderr)) {
          resolve({
            ok: false,
            stdout: "",
            truncated: false,
            retryWithSingleThread: true,
          });
          return;
        }

        if (execError.code === 1 && stderr.trim() === "") {
          resolve({ ok: true, stdout, exitCode: 1, truncated: false });
          return;
        }

        if (execError.killed === true || typeof execError.signal === "string") {
          resolve({
            ok: false,
            stdout,
            truncated: true,
            error: `ripgrep timed out after ${timeoutMs}ms. Narrow the search with path, glob, or a more specific pattern.`,
          });
          return;
        }

        if (execError.message.includes("maxBuffer")) {
          resolve({
            ok: false,
            stdout,
            truncated: true,
            error: `ripgrep output exceeded ${maxBufferBytes} bytes. Narrow the search with path, glob, or a more specific pattern.`,
          });
          return;
        }

        resolve({
          ok: false,
          stdout,
          exitCode: typeof execError.code === "number" ? execError.code : undefined,
          truncated: false,
          error: stderr.trim() !== "" ? stderr.trim() : execError.message,
        });
      },
    );
  });
}

function finalizeResult(attempt: RipgrepAttempt): RipgrepResult {
  if (attempt.ok) {
    return {
      ok: true,
      stdout: attempt.stdout,
      exitCode: attempt.exitCode,
      truncated: false,
    };
  }

  if (attempt.truncated && attempt.stdout.length > 0) {
    return {
      ok: true,
      stdout: attempt.stdout,
      exitCode: attempt.exitCode,
      truncated: true,
      error: attempt.error,
    };
  }

  return {
    ok: false,
    stdout: "",
    exitCode: attempt.exitCode,
    truncated: attempt.truncated,
    error: attempt.error ?? "ripgrep failed.",
  };
}

function isEagainError(
  error: Error & { code?: number | string },
  stderr: string,
): boolean {
  return (
    error.code === "EAGAIN" ||
    error.message.includes("EAGAIN") ||
    error.message.includes("Resource temporarily unavailable") ||
    stderr.includes("Resource temporarily unavailable")
  );
}
