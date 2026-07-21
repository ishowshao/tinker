import { execFile } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";
import { cancellationError, throwIfTurnCancelled } from "../agent/turn-cancellation";

export const RIPGREP_MISSING_ERROR =
  "Tinker's bundled ripgrep executable is unavailable. Reinstall tinker-agent.";

const defaultTimeoutMs = 20_000;
const defaultMaxBufferBytes = 20_000_000;

export type RipgrepResult = {
  ok: boolean;
  lines: string[];
  exitCode?: number;
  truncated: boolean;
  error?: string;
};

export type RipgrepOptions = {
  signal: AbortSignal;
  timeoutMs?: number;
  maxBufferBytes?: number;
};

export function findRipgrepCommand(): string {
  return process.env.TINKER_RIPGREP_PATH ?? rgPath;
}

export async function ripGrep(
  args: string[],
  options: RipgrepOptions,
): Promise<RipgrepResult> {
  throwIfTurnCancelled(options.signal);
  const timeoutMs =
    options.timeoutMs ??
    parsePositiveInteger(process.env.TINKER_GREP_TIMEOUT_MS, defaultTimeoutMs);
  const maxBufferBytes =
    options.maxBufferBytes ??
    parsePositiveInteger(
      process.env.TINKER_GREP_MAX_BUFFER_BYTES,
      defaultMaxBufferBytes,
    );

  const first = await runRipgrep(args, timeoutMs, maxBufferBytes, options.signal);
  if (first.retryWithSingleThread) {
    throwIfTurnCancelled(options.signal);
    return finalizeResult(
      await runRipgrep(["-j", "1", ...args], timeoutMs, maxBufferBytes, options.signal),
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
  args: string[],
  timeoutMs: number,
  maxBufferBytes: number,
  signal: AbortSignal,
): Promise<RipgrepAttempt> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(cancellationError(signal));
      return;
    }

    execFile(
      findRipgrepCommand(),
      args,
      { timeout: timeoutMs, maxBuffer: maxBufferBytes, signal },
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
  const lines = splitCompleteLines(attempt.stdout, attempt.truncated);

  if (attempt.ok) {
    return {
      ok: true,
      lines,
      exitCode: attempt.exitCode,
      truncated: false,
    };
  }

  if (attempt.truncated && lines.length > 0) {
    return {
      ok: true,
      lines,
      exitCode: attempt.exitCode,
      truncated: true,
      error: attempt.error,
    };
  }

  return {
    ok: false,
    lines: [],
    exitCode: attempt.exitCode,
    truncated: attempt.truncated,
    error: attempt.error ?? "ripgrep failed.",
  };
}

function splitCompleteLines(stdout: string, droppedPartialTail: boolean): string[] {
  if (stdout === "") {
    return [];
  }

  const lines = stdout.split("\n");
  const last = lines.at(-1);

  if (last === "") {
    lines.pop();
  } else if (droppedPartialTail) {
    lines.pop();
  }

  return lines;
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

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
