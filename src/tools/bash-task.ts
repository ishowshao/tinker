import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { createUuidV7 } from "../ids/uuid-v7";
import { isWorkspaceLocalCwd, type CwdState } from "./cwd-state";
import { TaskOutput } from "./task-output";

export type ShellTaskStatus = "running" | "completed" | "failed" | "killed";

export type ShellTask = {
  id: string;
  runId: string;
  command: string;
  description: string;
  status: ShellTaskStatus;
  exitCode?: number;
  signal?: string;
  error?: string;
  startedAt: string;
  endedAt?: string;
  outputFilePath: string;
  cwd: string;
  process: ChildProcessWithoutNullStreams;
  output: TaskOutput;
  completion: Promise<ShellTask>;
};

export type ShellTaskManagerOptions = {
  workspaceRoot: string;
  runId: string;
  cwdState: CwdState;
};

export class ShellTaskManager {
  readonly tasks = new Map<string, ShellTask>();

  constructor(private readonly options: ShellTaskManagerOptions) {}

  async start(input: { command: string; description: string }): Promise<ShellTask> {
    const id = createUuidV7();
    const outputFilePath = path.join(
      this.options.workspaceRoot,
      ".tinker",
      "bash",
      `${id}.log`,
    );
    const cwdFilePath = path.join(
      this.options.workspaceRoot,
      ".tinker",
      "bash",
      `${id}.cwd`,
    );
    await ensureEmptyFile(cwdFilePath);

    const output = await TaskOutput.create(outputFilePath);
    const child = spawn("bash", ["-lc", bashWrapperScript], {
      cwd: this.options.cwdState.cwd,
      env: {
        ...process.env,
        TINKER_BASH_COMMAND: input.command,
        TINKER_BASH_CWD_FILE: cwdFilePath,
      },
    });

    const task: ShellTask = {
      id,
      runId: this.options.runId,
      command: input.command,
      description: input.description,
      status: "running",
      startedAt: new Date().toISOString(),
      outputFilePath,
      cwd: this.options.cwdState.cwd,
      process: child,
      output,
      completion: Promise.resolve(undefined as never),
    };

    task.completion = this.monitorTask(task, cwdFilePath);
    this.tasks.set(id, task);
    return task;
  }

  private async monitorTask(task: ShellTask, cwdFilePath: string): Promise<ShellTask> {
    pipeTaskOutput(task.process.stdout, task.output);
    pipeTaskOutput(task.process.stderr, task.output);

    const closeResult = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: string;
    }>((resolve) => {
      task.process.once("error", (error) => {
        resolve({
          code: null,
          signal: null,
          error: error.message,
        });
      });
      task.process.once("close", (code, signal) => {
        resolve({ code, signal });
      });
    });

    await task.output.end();

    task.endedAt = new Date().toISOString();
    if (closeResult.error !== undefined) {
      task.status = "failed";
      task.error = closeResult.error;
    } else if (closeResult.signal !== null) {
      task.status = "killed";
      task.signal = closeResult.signal;
    } else {
      task.exitCode = closeResult.code ?? 1;
      task.status = task.exitCode === 0 ? "completed" : "failed";
    }

    await this.updateCwdFromFile(task, cwdFilePath);
    await unlinkIfExists(cwdFilePath);

    return task;
  }

  private async updateCwdFromFile(task: ShellTask, cwdFilePath: string): Promise<void> {
    try {
      const cwd = (await readFile(cwdFilePath, "utf8")).trim();
      if (cwd !== "" && isWorkspaceLocalCwd(this.options.workspaceRoot, cwd)) {
        task.cwd = cwd;
      }
    } catch {
      return;
    }
  }
}

function pipeTaskOutput(stream: NodeJS.ReadableStream, output: TaskOutput): void {
  stream.on("data", (chunk: Buffer | string) => {
    output.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
}

async function ensureEmptyFile(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const file = await open(filePath, "w");
  await file.close();
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

const bashWrapperScript = `
eval "$TINKER_BASH_COMMAND"
exit_code=$?
pwd -P > "$TINKER_BASH_CWD_FILE"
exit "$exit_code"
`;
