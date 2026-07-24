import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { PtyTerminalScreen } from "./pty-terminal-screen";

export type PtyKey =
  | "enter"
  | "escape"
  | "tab"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "page_up"
  | "page_down"
  | "ctrl_a"
  | "ctrl_d"
  | "ctrl_e"
  | "ctrl_u";

export type StartPtyTuiInput = {
  readonly fakeModel: string;
  readonly rows?: number;
  readonly columns?: number;
  readonly environment?: Readonly<Record<string, string>>;
  readonly workspaceFiles?: Readonly<Record<string, string | Uint8Array>>;
  readonly homeFiles?: Readonly<Record<string, string | Uint8Array>>;
};

export type PtyTuiFixtureInput = {
  readonly workspaceFiles?: Readonly<Record<string, string | Uint8Array>>;
  readonly homeFiles?: Readonly<Record<string, string | Uint8Array>>;
};

export interface PtyTuiFixture {
  readonly workspaceRoot: string;
  readonly homeRoot: string;

  start(
    input: Pick<StartPtyTuiInput, "fakeModel" | "rows" | "columns" | "environment">,
  ): Promise<PtyTuiHarness>;
  dispose(): Promise<void>;
}

export type PtyProcessExit = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
};

export type PtyWaitOptions = {
  readonly timeoutMs?: number;
  readonly message?: string;
};

export type PtyTranscriptWaitOptions = PtyWaitOptions & {
  readonly since?: number;
};

type PtyPredicate = string | RegExp | ((text: string) => boolean);

export interface PtyTuiHarness {
  readonly workspaceRoot: string;
  readonly homeRoot: string;

  type(text: string): Promise<void>;
  paste(text: string): Promise<void>;
  press(key: PtyKey): Promise<void>;
  mouseWheel(direction: "up" | "down", x?: number, y?: number): Promise<void>;
  resize(rows: number, columns: number): Promise<void>;

  screenText(): string;
  promptReady(): boolean;
  transcriptText(): string;
  markTranscript(): number;
  transcriptSince(mark: number): string;

  waitForScreen(predicate: PtyPredicate, options?: PtyWaitOptions): Promise<void>;
  waitForTranscript(
    predicate: PtyPredicate,
    options?: PtyTranscriptWaitOptions,
  ): Promise<void>;

  signalTui(signal: NodeJS.Signals): Promise<void>;
  waitForExit(timeoutMs?: number): Promise<PtyProcessExit | undefined>;
  wrapperExit(): PtyProcessExit | undefined;
  tuiExit(): PtyProcessExit | undefined;
  diagnosticText(expectedCondition: string): string;
  dispose(): Promise<void>;
}

const KEY_SEQUENCES: Readonly<Record<PtyKey, string>> = Object.freeze({
  enter: "\r",
  escape: "\x1b",
  tab: "\t",
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  home: "\x1b[H",
  end: "\x1b[F",
  page_up: "\x1b[5~",
  page_down: "\x1b[6~",
  ctrl_a: "\x01",
  ctrl_d: "\x04",
  ctrl_e: "\x05",
  ctrl_u: "\x15",
});

const DEFAULT_ROWS = 30;
const DEFAULT_COLUMNS = 120;
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_EXIT_TIMEOUT_MS = 2_000;
const CONTROL_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 25;

type PendingControl = {
  readonly operation: string;
  readonly resolve: (response: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
};

export function ptyKeySequence(key: PtyKey): string {
  return KEY_SEQUENCES[key];
}

export function bracketedPasteSequence(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

export function normalizeScreenWhitespace(screen: string): string {
  return screen.replace(/\s+/gu, " ").trim();
}

export function mouseWheelSequence(direction: "up" | "down", x = 1, y = 1): string {
  return `\x1b[<${direction === "up" ? 64 : 65};${x};${y}M`;
}

export async function startPtyTui(input: StartPtyTuiInput): Promise<PtyTuiHarness> {
  if (input.fakeModel.trim() === "") {
    throw new Error("PTY fakeModel must be a non-empty string.");
  }
  const rows = positiveInteger(input.rows ?? DEFAULT_ROWS, "rows");
  const columns = positiveInteger(input.columns ?? DEFAULT_COLUMNS, "columns");
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tinker-pty-"));
  const homeRoot = path.join(temporaryRoot, "home");
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  await Promise.all([
    mkdir(homeRoot, { recursive: true }),
    mkdir(workspaceRoot, { recursive: true }),
  ]);

  try {
    await Promise.all([
      writeFixtureFiles(workspaceRoot, input.workspaceFiles),
      writeFixtureFiles(homeRoot, input.homeFiles),
    ]);
    const harness = new PtyTuiHarnessImpl({
      scenario: input.fakeModel,
      rows,
      columns,
      temporaryRoot,
      homeRoot,
      workspaceRoot,
      environment: isolatedTuiEnvironment(input, homeRoot, workspaceRoot),
      removeTemporaryRootOnDispose: true,
    });
    try {
      await harness.waitUntilHostReady();
      return harness;
    } catch (error) {
      try {
        await harness.dispose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "PTY harness startup and cleanup both failed.",
          { cause: cleanupError },
        );
      }
      throw error;
    }
  } catch (error) {
    try {
      await removeTemporaryRoot(temporaryRoot);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "PTY harness setup and temporary-root cleanup both failed.",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

export async function createPtyTuiFixture(
  input: PtyTuiFixtureInput = {},
): Promise<PtyTuiFixture> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tinker-pty-"));
  const homeRoot = path.join(temporaryRoot, "home");
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  await Promise.all([
    mkdir(homeRoot, { recursive: true }),
    mkdir(workspaceRoot, { recursive: true }),
  ]);

  try {
    await Promise.all([
      writeFixtureFiles(workspaceRoot, input.workspaceFiles),
      writeFixtureFiles(homeRoot, input.homeFiles),
    ]);
  } catch (error) {
    await removeTemporaryRoot(temporaryRoot);
    throw error;
  }

  let disposed = false;
  return {
    workspaceRoot,
    homeRoot,
    async start(startInput) {
      if (disposed) {
        throw new Error("Cannot start a PTY from a disposed fixture.");
      }
      if (startInput.fakeModel.trim() === "") {
        throw new Error("PTY fakeModel must be a non-empty string.");
      }
      const rows = positiveInteger(startInput.rows ?? DEFAULT_ROWS, "rows");
      const columns = positiveInteger(startInput.columns ?? DEFAULT_COLUMNS, "columns");
      const harness = new PtyTuiHarnessImpl({
        scenario: startInput.fakeModel,
        rows,
        columns,
        temporaryRoot,
        homeRoot,
        workspaceRoot,
        environment: isolatedTuiEnvironment(startInput, homeRoot, workspaceRoot),
        removeTemporaryRootOnDispose: false,
      });
      try {
        await harness.waitUntilHostReady();
        return harness;
      } catch (error) {
        try {
          await harness.dispose();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Shared PTY harness startup and cleanup both failed.",
            { cause: cleanupError },
          );
        }
        throw error;
      }
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      await removeTemporaryRoot(temporaryRoot);
    },
  };
}

export async function withPtyTui<T>(
  input: StartPtyTuiInput,
  run: (harness: PtyTuiHarness) => Promise<T>,
): Promise<T> {
  const harness = await startPtyTui(input);
  let outcome:
    | { readonly status: "completed"; readonly value: T }
    | { readonly status: "failed"; readonly error: unknown };
  try {
    outcome = { status: "completed", value: await run(harness) };
  } catch (error) {
    outcome = { status: "failed", error };
  }

  try {
    await harness.dispose();
  } catch (cleanupError) {
    if (outcome.status === "failed") {
      throw new AggregateError(
        [outcome.error, cleanupError],
        "PTY scenario and cleanup both failed.",
        { cause: cleanupError },
      );
    }
    throw cleanupError;
  }

  if (outcome.status === "failed") {
    throw outcome.error;
  }
  return outcome.value;
}

class PtyTuiHarnessImpl implements PtyTuiHarness {
  readonly workspaceRoot: string;
  readonly homeRoot: string;

  private readonly scenario: string;
  private readonly temporaryRoot: string;
  private readonly removeTemporaryRootOnDispose: boolean;
  private readonly controlSocketPath: string;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly screen: PtyTerminalScreen;
  private readonly pendingControl = new Map<number, PendingControl>();
  private control: Socket | undefined;
  private transcript = "";
  private hostStderr = "";
  private controlBuffer = "";
  private nextControlId = 1;
  private childPid: number | undefined;
  private tuiExitState: PtyProcessExit | undefined;
  private spawnError: Error | undefined;
  private screenError: Error | undefined;
  private controlError: Error | undefined;
  private wrapperIsClosed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(input: {
    readonly scenario: string;
    readonly rows: number;
    readonly columns: number;
    readonly temporaryRoot: string;
    readonly homeRoot: string;
    readonly workspaceRoot: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly removeTemporaryRootOnDispose: boolean;
  }) {
    this.scenario = input.scenario;
    this.temporaryRoot = input.temporaryRoot;
    this.removeTemporaryRootOnDispose = input.removeTemporaryRootOnDispose;
    this.homeRoot = input.homeRoot;
    this.workspaceRoot = input.workspaceRoot;
    this.controlSocketPath = path.join(input.temporaryRoot, "control.sock");
    this.screen = new PtyTerminalScreen(input.rows, input.columns);

    const repositoryRoot = path.resolve(import.meta.dir, "../../..");
    this.child = spawn(
      "python3",
      [
        path.join(import.meta.dir, "../fixtures/pty-host.py"),
        "--rows",
        String(input.rows),
        "--columns",
        String(input.columns),
        "--control-socket",
        this.controlSocketPath,
        "--",
        "node",
        path.join(repositoryRoot, "bin/tinker.js"),
      ],
      {
        cwd: input.workspaceRoot,
        env: input.environment,
        stdio: "pipe",
      },
    );

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.transcript += chunk;
      void this.screen.write(chunk).catch((error: unknown) => {
        this.screenError = errorFromUnknown(error);
      });
    });
    this.child.stderr.on("data", (chunk: string) => {
      this.hostStderr += chunk;
    });
    this.child.once("error", (error) => {
      this.spawnError = error;
    });
    this.child.once("close", () => {
      this.wrapperIsClosed = true;
    });
  }

  async waitUntilHostReady(): Promise<void> {
    try {
      await this.connectControlSocket();
      const deadline = Date.now() + 5_000;
      while (this.childPid === undefined) {
        this.throwIfUnavailable("PTY host ready acknowledgement");
        if (Date.now() >= deadline) {
          throw new Error("PTY host did not acknowledge startup within 5000ms.");
        }
        await Bun.sleep(POLL_INTERVAL_MS);
      }
    } catch (error) {
      throw new Error(
        this.diagnostic(
          "PTY host ready acknowledgement",
          errorFromUnknown(error).message,
        ),
        { cause: error },
      );
    }
  }

  async type(text: string): Promise<void> {
    await this.writeInput(text);
  }

  async paste(text: string): Promise<void> {
    await this.writeInput(bracketedPasteSequence(text));
  }

  async press(key: PtyKey): Promise<void> {
    await this.writeInput(ptyKeySequence(key));
  }

  async mouseWheel(direction: "up" | "down", x = 1, y = 1): Promise<void> {
    const column = coordinate(x, this.screen.columns, "mouse x");
    const row = coordinate(y, this.screen.rows, "mouse y");
    await this.writeInput(mouseWheelSequence(direction, column, row));
  }

  async resize(rows: number, columns: number): Promise<void> {
    const nextRows = positiveInteger(rows, "rows");
    const nextColumns = positiveInteger(columns, "columns");
    const previousRows = this.screen.rows;
    const previousColumns = this.screen.columns;
    await this.screen.resize(nextRows, nextColumns);
    try {
      const response = await this.sendControl({
        op: "resize",
        rows: nextRows,
        columns: nextColumns,
      });
      if (
        response.op !== "resize" ||
        response.rows !== nextRows ||
        response.columns !== nextColumns
      ) {
        throw new Error(
          `PTY host returned an invalid resize acknowledgement: ${JSON.stringify(response)}.`,
        );
      }
    } catch (error) {
      await this.screen.resize(previousRows, previousColumns);
      throw new Error(
        this.diagnostic(
          `resize acknowledgement for ${nextRows} x ${nextColumns}`,
          errorFromUnknown(error).message,
        ),
        { cause: error },
      );
    }
  }

  screenText(): string {
    return this.screen.text();
  }

  promptReady(): boolean {
    return (
      this.screen.bracketedPasteMode &&
      this.screen.text().includes('Enter a coding request, or "/" for commands')
    );
  }

  transcriptText(): string {
    return this.transcript;
  }

  markTranscript(): number {
    return this.transcript.length;
  }

  transcriptSince(mark: number): string {
    if (!Number.isSafeInteger(mark) || mark < 0 || mark > this.transcript.length) {
      throw new Error(
        `Transcript mark must be an integer between 0 and ${this.transcript.length}; received ${mark}.`,
      );
    }
    return this.transcript.slice(mark);
  }

  async waitForScreen(
    predicate: PtyPredicate,
    options: PtyWaitOptions = {},
  ): Promise<void> {
    const timeoutMs = waitTimeout(options.timeoutMs);
    const expected = options.message ?? describePredicate(predicate);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      await this.flushScreen(`screen: ${expected}`);
      const current = this.screenText();
      if (matches(predicate, current)) {
        return;
      }
      this.throwIfUnavailable(`screen: ${expected}`);
      if (Date.now() >= deadline) {
        throw new Error(
          this.diagnostic(
            `screen: ${expected}`,
            `condition was not met within ${timeoutMs}ms`,
          ),
        );
      }
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  }

  async waitForTranscript(
    predicate: PtyPredicate,
    options: PtyTranscriptWaitOptions = {},
  ): Promise<void> {
    const timeoutMs = waitTimeout(options.timeoutMs);
    const mark = options.since ?? 0;
    const expected = options.message ?? describePredicate(predicate);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const current = this.transcriptSince(mark);
      if (matches(predicate, current)) {
        return;
      }
      this.throwIfUnavailable(`transcript: ${expected}`);
      if (Date.now() >= deadline) {
        await this.flushScreen(`transcript: ${expected}`);
        throw new Error(
          this.diagnostic(
            `transcript since ${mark}: ${expected}`,
            `condition was not met within ${timeoutMs}ms`,
          ),
        );
      }
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  }

  async signalTui(signal: NodeJS.Signals): Promise<void> {
    const response = await this.sendControl({
      op: "signal_child",
      signal,
    });
    if (response.op !== "signal_child" || response.signal !== signal) {
      throw new Error(
        this.diagnostic(
          `signal acknowledgement for ${signal}`,
          `invalid response: ${JSON.stringify(response)}`,
        ),
      );
    }
  }

  async waitForExit(
    timeoutMs = DEFAULT_EXIT_TIMEOUT_MS,
  ): Promise<PtyProcessExit | undefined> {
    const timeout = nonNegativeInteger(timeoutMs, "timeoutMs");
    const deadline = Date.now() + timeout;
    while (true) {
      const wrapperExit = this.wrapperExit();
      const tuiExit = this.tuiExit();
      if (wrapperExit !== undefined && tuiExit !== undefined && this.wrapperIsClosed) {
        await this.flushScreen("final screen after process exit");
        return tuiExit;
      }
      if (Date.now() >= deadline) {
        return undefined;
      }
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  }

  wrapperExit(): PtyProcessExit | undefined {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      return undefined;
    }
    return {
      code: this.child.exitCode,
      signal: this.child.signalCode,
    };
  }

  tuiExit(): PtyProcessExit | undefined {
    return this.tuiExitState;
  }

  diagnosticText(expectedCondition: string): string {
    return this.diagnostic(expectedCondition, "state snapshot requested");
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.performDispose();
    return this.disposePromise;
  }

  private async connectControlSocket(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (true) {
      if (this.spawnError !== undefined) {
        throw this.spawnError;
      }
      const wrapperExit = this.wrapperExit();
      if (wrapperExit !== undefined) {
        throw new Error(
          `PTY host exited before opening its control socket: ${formatExit(wrapperExit)}.`,
        );
      }
      try {
        const control = await connectUnixSocket(this.controlSocketPath);
        this.control = control;
        control.setEncoding("utf8");
        control.on("data", (chunk: string) => {
          this.receiveControlData(chunk);
        });
        control.once("end", () => {
          if (this.tuiExitState === undefined && this.wrapperExit() === undefined) {
            this.failControl(new Error("PTY host control socket closed unexpectedly."));
          }
        });
        control.once("error", (error) => {
          if (this.wrapperExit() === undefined) {
            this.failControl(error);
          }
        });
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ECONNREFUSED" && code !== "EAGAIN") {
          throw error;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error("PTY host did not open its control socket within 5000ms.");
      }
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  }

  private async flushScreen(expected: string): Promise<void> {
    try {
      await this.screen.flush();
    } catch (error) {
      const screenError = errorFromUnknown(error);
      this.screenError ??= screenError;
      throw new Error(this.diagnostic(expected, screenError.message), {
        cause: error,
      });
    }
  }

  private async performDispose(): Promise<void> {
    const errors: Error[] = [];

    if (this.wrapperExit() === undefined) {
      try {
        await this.press("ctrl_u");
        await this.type("/quit");
        await this.press("enter");
      } catch {
        // The PTY may already be closing; the bounded process cleanup below owns it.
      }
      await this.waitForExit(DEFAULT_EXIT_TIMEOUT_MS);
    }

    if (this.wrapperExit() === undefined) {
      this.child.kill("SIGTERM");
      await waitForProcessExit(this.child, DEFAULT_EXIT_TIMEOUT_MS);
    }

    if (this.wrapperExit() === undefined) {
      this.child.kill("SIGKILL");
      await waitForProcessExit(this.child, DEFAULT_EXIT_TIMEOUT_MS);
    }

    if (this.wrapperExit() === undefined) {
      errors.push(new Error("PTY host did not exit after SIGKILL."));
    }

    if (this.wrapperExit() !== undefined && !this.wrapperIsClosed) {
      await waitForCondition(() => this.wrapperIsClosed, DEFAULT_EXIT_TIMEOUT_MS);
      if (!this.wrapperIsClosed) {
        errors.push(new Error("PTY host stdio did not close after process exit."));
      }
    }

    if (this.childPid !== undefined) {
      try {
        if (!(await waitForProcessGroupExit(this.childPid, 500))) {
          errors.push(
            new Error(
              `Tinker PTY process group ${this.childPid} remained alive after host cleanup.`,
            ),
          );
          await stopProcessGroup(this.childPid);
        }
      } catch (error) {
        errors.push(errorFromUnknown(error));
      }
    }

    for (const pending of this.pendingControl.values()) {
      clearTimeout(pending.timeout);
      pending.reject(
        new Error(`PTY host stopped before ${pending.operation} was acknowledged.`),
      );
    }
    this.pendingControl.clear();
    this.child.stdin.destroy();
    this.control?.destroy();

    try {
      await this.screen.flush();
    } catch (error) {
      errors.push(errorFromUnknown(error));
    }
    const cleanupDiagnostic = this.diagnostic("complete PTY cleanup", "cleanup failed");
    try {
      this.screen.dispose();
    } catch (error) {
      errors.push(errorFromUnknown(error));
    }

    if (this.removeTemporaryRootOnDispose) {
      try {
        await removeTemporaryRoot(this.temporaryRoot);
      } catch (error) {
        errors.push(errorFromUnknown(error));
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, cleanupDiagnostic);
    }
  }

  private async writeInput(data: string): Promise<void> {
    if (this.wrapperExit() !== undefined || this.tuiExitState !== undefined) {
      throw new Error(
        this.diagnostic("writable Tinker PTY", "Tinker has already exited"),
      );
    }
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(data, (error) => {
        if (error === null || error === undefined) {
          resolve();
          return;
        }
        reject(error);
      });
    });
  }

  private async sendControl(
    message: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    if (this.wrapperExit() !== undefined) {
      throw new Error("PTY host has already exited.");
    }
    if (this.controlError !== undefined) {
      throw this.controlError;
    }
    const control = this.control;
    if (control === undefined) {
      throw new Error("PTY host control socket is not connected.");
    }

    const id = this.nextControlId;
    this.nextControlId += 1;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingControl.delete(id);
        reject(
          new Error(
            `PTY host did not acknowledge ${String(message.op)} within ${CONTROL_TIMEOUT_MS}ms.`,
          ),
        );
      }, CONTROL_TIMEOUT_MS);
      timeout.unref();
      this.pendingControl.set(id, {
        operation: String(message.op),
        resolve,
        reject,
        timeout,
      });
      control.write(`${JSON.stringify({ id, ...message })}\n`, (error) => {
        if (error === null || error === undefined) {
          return;
        }
        const pending = this.pendingControl.get(id);
        if (pending === undefined) {
          return;
        }
        this.pendingControl.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(error);
      });
    });
  }

  private receiveControlData(chunk: string): void {
    this.controlBuffer += chunk;
    while (this.controlBuffer.includes("\n")) {
      const newline = this.controlBuffer.indexOf("\n");
      const line = this.controlBuffer.slice(0, newline);
      this.controlBuffer = this.controlBuffer.slice(newline + 1);
      if (line === "") {
        continue;
      }
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.failControl(
          new Error(`PTY host returned invalid control JSON: ${line}`, {
            cause: error,
          }),
        );
        continue;
      }
      this.receiveControlMessage(message);
    }
  }

  private receiveControlMessage(message: unknown): void {
    if (!isRecord(message)) {
      this.failControl(new Error("PTY host control response must be an object."));
      return;
    }

    if (message.op === "ready") {
      if (
        typeof message.childPid !== "number" ||
        !Number.isSafeInteger(message.childPid) ||
        message.childPid <= 0 ||
        message.rows !== this.screen.rows ||
        message.columns !== this.screen.columns
      ) {
        this.failControl(
          new Error(
            `PTY host returned an invalid ready message: ${JSON.stringify(message)}.`,
          ),
        );
        return;
      }
      this.childPid = message.childPid;
      return;
    }

    if (message.op === "child_exit") {
      if (
        !(
          (typeof message.code === "number" &&
            Number.isSafeInteger(message.code) &&
            message.code >= 0 &&
            message.signal === null) ||
          (message.code === null && typeof message.signal === "string")
        )
      ) {
        this.failControl(
          new Error(
            `PTY host returned an invalid child exit: ${JSON.stringify(message)}.`,
          ),
        );
        return;
      }
      this.tuiExitState = {
        code: message.code,
        signal: message.signal as NodeJS.Signals | null,
      };
      this.control?.write('{"op":"ack_child_exit"}\n', (error) => {
        if (error !== null && error !== undefined && this.wrapperExit() === undefined) {
          this.failControl(error);
        }
      });
      return;
    }

    if (!Number.isSafeInteger(message.id)) {
      this.failControl(
        new Error(
          `PTY host returned an unrecognized control message: ${JSON.stringify(message)}.`,
        ),
      );
      return;
    }
    const id = message.id as number;
    const pending = this.pendingControl.get(id);
    if (pending === undefined) {
      this.failControl(new Error(`PTY host returned an unexpected response id ${id}.`));
      return;
    }
    this.pendingControl.delete(id);
    clearTimeout(pending.timeout);
    if (message.ok !== true) {
      pending.reject(
        new Error(
          typeof message.error === "string"
            ? message.error
            : `PTY host rejected ${pending.operation}.`,
        ),
      );
      return;
    }
    pending.resolve(message);
  }

  private failControl(error: Error): void {
    this.controlError ??= error;
    for (const pending of this.pendingControl.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingControl.clear();
  }

  private throwIfUnavailable(expected: string): void {
    const harnessError = this.spawnError ?? this.screenError ?? this.controlError;
    if (harnessError !== undefined) {
      throw new Error(this.diagnostic(expected, harnessError.message), {
        cause: harnessError,
      });
    }
    const tuiExit = this.tuiExit();
    const wrapperExit = this.wrapperExit();
    if (tuiExit !== undefined || wrapperExit !== undefined) {
      throw new Error(
        this.diagnostic(
          expected,
          `process exited early; wrapper=${formatExit(wrapperExit)}, child=${formatExit(tuiExit)}`,
        ),
      );
    }
  }

  private diagnostic(expected: string, detail: string): string {
    return [
      `scenario: ${this.scenario}`,
      `expected condition: ${expected}`,
      `failure: ${detail}`,
      "current screen:",
      this.screenTextForDiagnostic(),
      "last 8 KiB transcript:",
      tailUtf8(this.transcript, 8 * 1_024) || "<empty>",
      "pty-host stderr:",
      tailUtf8(this.hostStderr, 4 * 1_024) || "<empty>",
      `wrapper exit state: ${formatExit(this.wrapperExit())}`,
      `child exit state: ${formatExit(this.tuiExit())}`,
      `rows x columns: ${this.screen.rows} x ${this.screen.columns}`,
      `workspaceRoot: ${this.workspaceRoot}`,
      `homeRoot: ${this.homeRoot}`,
    ].join("\n");
  }

  private screenTextForDiagnostic(): string {
    try {
      return this.screenText() || "<empty>";
    } catch (error) {
      return `<screen unavailable: ${errorFromUnknown(error).message}>`;
    }
  }
}

function isolatedTuiEnvironment(
  input: StartPtyTuiInput,
  homeRoot: string,
  workspaceRoot: string,
): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("TINKER_") || name === "EXA_API_KEY" || name === "CI") {
      delete environment[name];
    }
  }
  Object.assign(environment, {
    TINKER_API_KEY: "pty-placeholder-key",
    TINKER_BASE_URL: "https://api.example.test/v1",
    TINKER_CONTEXT_WINDOW_TOKENS: String(128 * 1_024),
    TINKER_MAX_SUPPORTED_OUTPUT_TOKENS: String(16 * 1_024),
    TINKER_MODEL: "pty-test-model",
    TINKER_MODELS: "",
    TINKER_STREAM: "false",
    ...input.environment,
    HOME: homeRoot,
    NO_COLOR: "1",
    TERM: "xterm-256color",
    TINKER_TEST_FAKE_MODEL: input.fakeModel,
    TINKER_WORKSPACE: workspaceRoot,
  });
  delete environment.CI;
  delete environment.EXA_API_KEY;
  return environment;
}

async function writeFixtureFiles(
  root: string,
  files: Readonly<Record<string, string | Uint8Array>> | undefined,
): Promise<void> {
  if (files === undefined) {
    return;
  }
  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const target = fixturePath(root, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }),
  );
}

async function removeTemporaryRoot(temporaryRoot: string): Promise<void> {
  try {
    await rm(temporaryRoot, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function fixturePath(root: string, relativePath: string): string {
  if (relativePath === "" || path.isAbsolute(relativePath)) {
    throw new Error(
      `PTY fixture path must be a non-empty relative path: ${JSON.stringify(relativePath)}.`,
    );
  }
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(
      `PTY fixture path escapes its temporary root: ${JSON.stringify(relativePath)}.`,
    );
  }
  return target;
}

function matches(predicate: PtyPredicate, text: string): boolean {
  if (typeof predicate === "string") {
    return text.includes(predicate);
  }
  if (predicate instanceof RegExp) {
    predicate.lastIndex = 0;
    return predicate.test(text);
  }
  return predicate(text);
}

function describePredicate(predicate: PtyPredicate): string {
  if (typeof predicate === "string") {
    return `include ${JSON.stringify(predicate)}`;
  }
  if (predicate instanceof RegExp) {
    return `match ${String(predicate)}`;
  }
  return "satisfy the supplied predicate";
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer; received ${value}.`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer; received ${value}.`);
  }
  return value;
}

function waitTimeout(value: number | undefined): number {
  return positiveInteger(value ?? DEFAULT_WAIT_TIMEOUT_MS, "timeoutMs");
}

function coordinate(value: number, maximum: number, name: string): number {
  const coordinateValue = positiveInteger(value, name);
  if (coordinateValue > maximum) {
    throw new Error(`${name} must not exceed ${maximum}; received ${coordinateValue}.`);
  }
  return coordinateValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function formatExit(exit: PtyProcessExit | undefined): string {
  return exit === undefined ? "<running>" : JSON.stringify(exit);
}

function tailUtf8(value: string, maximumBytes: number): string {
  const encoded = Buffer.from(value);
  if (encoded.byteLength <= maximumBytes) {
    return value;
  }
  return encoded.subarray(encoded.byteLength - maximumBytes).toString("utf8");
}

function connectUnixSocket(socketPath: string): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection(socketPath);
    const handleError = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", handleError);
    socket.once("connect", () => {
      socket.off("error", handleError);
      resolve(socket);
    });
  });
}

async function waitForProcessExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (
    child.exitCode === null &&
    child.signalCode === null &&
    Date.now() < deadline
  ) {
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

function processGroupIsAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }
    if (code === "EPERM") {
      return true;
    }
    throw error;
  }
}

async function stopProcessGroup(processGroupId: number): Promise<void> {
  try {
    process.kill(-processGroupId, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
    return;
  }
  const deadline = Date.now() + 500;
  while (processGroupIsAlive(processGroupId) && Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  if (!processGroupIsAlive(processGroupId)) {
    return;
  }
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
  if (!(await waitForProcessGroupExit(processGroupId, 500))) {
    throw new Error(`Process group ${processGroupId} remained alive after SIGKILL.`);
  }
}

async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupIsAlive(processGroupId) && Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  return !processGroupIsAlive(processGroupId);
}
