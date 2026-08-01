import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { TERMINAL_SCREEN_COLUMNS, TERMINAL_SCREEN_ROWS } from "./terminal-screen";

export type ShellProcessMode = "pipe" | "pty";

export type ProcessExitResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
};

export type ShellProcessHandle = {
  readonly pid: number;
  readonly mode: ShellProcessMode;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  wait(): Promise<ProcessExitResult>;
  waitForOutputClose(): Promise<void>;
  write?(chars: string): Promise<number>;
  close(): void;
};

export class ShellProcessWriteError extends Error {
  constructor(
    message: string,
    readonly writtenBytes: number,
  ) {
    super(message);
    this.name = "ShellProcessWriteError";
  }
}

export async function spawnShellProcess(input: {
  mode: ShellProcessMode;
  command: string;
  cwd: string;
  cwdFilePath: string;
  onOutput(bytes: Uint8Array): void;
}): Promise<ShellProcessHandle> {
  const env = {
    ...process.env,
    NO_COLOR: "1",
    TINKER_BASH_COMMAND: input.command,
    TINKER_BASH_CWD_FILE: input.cwdFilePath,
  };

  if (input.mode === "pty") {
    return spawnPtyShellProcess({ ...input, env });
  }

  return spawnPipeShellProcess({ ...input, env });
}

async function spawnPipeShellProcess(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  onOutput(bytes: Uint8Array): void;
}): Promise<ShellProcessHandle> {
  const child = spawn("bash", ["-lc", bashWrapperScript], {
    cwd: input.cwd,
    detached: true,
    env: input.env,
  });
  pipeOutput(child.stdout, (bytes) => input.onOutput(bytes));
  pipeOutput(child.stderr, (bytes) => input.onOutput(bytes));

  const exit = waitForNodeProcessExit(child);
  const close = waitForNodeProcessClose(child);
  if (child.pid === undefined) {
    const result = await exit;
    throw new Error(result.error ?? "Bash process failed to start.");
  }

  return {
    pid: child.pid,
    mode: "pipe",
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    wait: () => exit,
    waitForOutputClose: () => close,
    close() {},
  };
}

function spawnPtyShellProcess(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  onOutput(bytes: Uint8Array): void;
}): ShellProcessHandle {
  let terminalEnded = false;
  let terminalExitError: Error | undefined;
  let resolveTerminalExit: (() => void) | undefined;
  let drainGeneration = 0;
  const drainWaiters = new Set<() => void>();
  const terminalExit = new Promise<void>((resolve) => {
    resolveTerminalExit = resolve;
  });
  const notifyDrain = () => {
    drainGeneration += 1;
    for (const resolve of drainWaiters) {
      resolve();
    }
    drainWaiters.clear();
  };
  const settleTerminalExit = () => {
    if (terminalEnded) {
      return;
    }
    terminalEnded = true;
    notifyDrain();
    resolveTerminalExit?.();
  };

  const subprocess = Bun.spawn(["bash", "-lc", bashWrapperScript], {
    cwd: input.cwd,
    detached: true,
    env: {
      ...input.env,
      TERM: "xterm-256color",
      NO_COLOR: "1",
      PAGER: "cat",
      GIT_PAGER: "cat",
    },
    terminal: {
      cols: TERMINAL_SCREEN_COLUMNS,
      rows: TERMINAL_SCREEN_ROWS,
      name: "xterm-256color",
      data(_terminal, bytes) {
        input.onOutput(new Uint8Array(bytes));
      },
      exit(_terminal, exitCode) {
        if (terminalEnded) {
          return;
        }
        if (exitCode !== 0) {
          terminalExitError = new Error(
            `PTY output stream closed with lifecycle status ${exitCode}.`,
          );
        }
        settleTerminalExit();
      },
      drain() {
        notifyDrain();
      },
    },
  });
  const terminal = subprocess.terminal!;

  let writeQueue = Promise.resolve();
  const write = (chars: string): Promise<number> => {
    const bytes = new TextEncoder().encode(chars);
    const operation = writeQueue.then(async () => {
      let writtenBytes = 0;
      try {
        while (writtenBytes < bytes.byteLength) {
          if (terminalEnded || terminal.closed) {
            throw new Error("PTY is closed.");
          }

          const generationBeforeWrite = drainGeneration;
          const accepted = terminal.write(bytes.subarray(writtenBytes));
          if (accepted < 0 || accepted > bytes.byteLength - writtenBytes) {
            throw new Error(`PTY accepted an invalid byte count: ${accepted}.`);
          }
          writtenBytes += accepted;

          if (writtenBytes < bytes.byteLength) {
            await waitForDrainOrExit({
              generationBeforeWrite,
              currentGeneration: () => drainGeneration,
              terminalEnded: () => terminalEnded || terminal.closed,
              drainWaiters,
            });
          }
        }
        return writtenBytes;
      } catch (error) {
        throw new ShellProcessWriteError(
          error instanceof Error ? error.message : String(error),
          writtenBytes,
        );
      }
    });
    writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  const exit = subprocess.exited.then(
    (code): ProcessExitResult => ({
      code: subprocess.signalCode === null ? code : null,
      signal: subprocess.signalCode,
    }),
    (error): ProcessExitResult => ({
      code: null,
      signal: null,
      error: error instanceof Error ? error.message : String(error),
    }),
  );

  return {
    pid: subprocess.pid,
    mode: "pty",
    get exitCode() {
      return subprocess.exitCode;
    },
    get signalCode() {
      return subprocess.signalCode;
    },
    wait: () => exit,
    async waitForOutputClose() {
      await terminalExit;
      if (terminalExitError !== undefined) {
        throw terminalExitError;
      }
    },
    write,
    close() {
      if (!terminal.closed) {
        terminal.close();
      }
    },
  };
}

async function waitForDrainOrExit(input: {
  generationBeforeWrite: number;
  currentGeneration(): number;
  terminalEnded(): boolean;
  drainWaiters: Set<() => void>;
}): Promise<void> {
  if (
    input.currentGeneration() !== input.generationBeforeWrite ||
    input.terminalEnded()
  ) {
    return;
  }

  await new Promise<void>((resolve) => {
    input.drainWaiters.add(resolve);
    if (
      input.currentGeneration() !== input.generationBeforeWrite ||
      input.terminalEnded()
    ) {
      input.drainWaiters.delete(resolve);
      resolve();
    }
  });
}

function waitForNodeProcessExit(
  process: ChildProcessWithoutNullStreams,
): Promise<ProcessExitResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ProcessExitResult) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    process.once("error", (error) => {
      finish({ code: null, signal: null, error: error.message });
    });
    process.once("exit", (code, signal) => {
      finish({ code, signal });
    });
  });
}

function waitForNodeProcessClose(
  process: ChildProcessWithoutNullStreams,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    process.once("error", finish);
    process.once("close", finish);
  });
}

function pipeOutput(
  stream: NodeJS.ReadableStream,
  onOutput: (bytes: Uint8Array) => void,
): void {
  stream.on("data", (chunk: Buffer | string) => {
    onOutput(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
}

const bashWrapperScript = `
eval "$TINKER_BASH_COMMAND"
exit_code=$?
pwd -P > "$TINKER_BASH_CWD_FILE"
exit "$exit_code"
`;
