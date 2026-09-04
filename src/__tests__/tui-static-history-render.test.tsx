import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import type { ToolCall } from "../agent/types";
import type { AgentEvent } from "../events/types";
import type { IterationId, SessionId, ToolCallId, TurnId } from "../ids/runtime-id";
import type { ShellTaskSnapshot } from "../tools/bash-task";
import { App } from "../tui/app";
import type {
  TuiSessionBinding,
  TuiSessionController,
} from "../tui/tui-session-controller";
import { TuiProjectionStore } from "../tui/tui-projection-store";
import { createTestRuntime } from "./test-runtime";

const sessionId = "static-history-session" as SessionId;
const historySentinel = "STATIC_HISTORY_EARLY_SENTINEL";
const testBashGuard = Object.freeze({
  mode: "guard" as const,
  source: "default" as const,
});

test("running interactive frames do not clear or replay committed history", async () => {
  const store = new TuiProjectionStore({
    sessionId,
    modelName: "test-model",
    workspaceRoot: "/tmp/tinker",
  });
  let sequence = 0;
  for (let turnNumber = 1; turnNumber <= 6; turnNumber += 1) {
    sequence += 1;
    await store.append(
      turnStarted(sequence, turnNumber, `history prompt ${turnNumber}`),
    );
    sequence += 1;
    await store.append(
      turnFinished(
        sequence,
        turnNumber,
        [
          turnNumber === 1 ? historySentinel : `history answer ${turnNumber}`,
          ...Array.from(
            { length: 6 },
            (_, index) => `- settled history ${turnNumber}.${index + 1}`,
          ),
        ].join("\n"),
      ),
    );
  }

  const output = new CapturedTtyOutput(24, 120);
  const input = new TestTtyInput();
  const view = render(<App sessionController={controller(store)} />, {
    stdout: output as unknown as NodeJS.WriteStream,
    stdin: input as unknown as NodeJS.ReadStream,
    interactive: true,
    incrementalRendering: true,
    patchConsole: false,
    exitOnCtrlC: false,
    maxFps: 60,
  });

  try {
    await view.waitUntilRenderFlush();
    expect(output.text()).toContain(historySentinel);
    const mark = output.mark();

    const turnNumber = 7;
    const turnId = `turn-${turnNumber}` as TurnId;
    const iterationId = `turn-${turnNumber}-iteration-1` as IterationId;
    sequence += 1;
    await store.append(
      turnStarted(sequence, turnNumber, "exercise bounded live history"),
    );
    await view.waitUntilRenderFlush();
    sequence += 1;
    await store.append({
      type: "model.request.started",
      sessionId,
      turnId,
      turnNumber,
      iterationId,
      iterationNumber: 1,
      eventSequence: sequence,
      timestamp: timestamp(sequence),
      data: { attemptNumber: 1, maxAttempts: 2 },
    });
    await view.waitUntilRenderFlush();

    for (let index = 1; index <= 7; index += 1) {
      sequence += 1;
      const task = backgroundTask(turnNumber, iterationId, index);
      await store.append({
        type: "bash.task.backgrounded",
        ...task.origin,
        eventSequence: sequence,
        timestamp: timestamp(sequence),
        data: { task },
      });
      await view.waitUntilRenderFlush();
    }

    const call = bashCall(turnNumber, iterationId);
    sequence += 1;
    await store.append({
      type: "model.request.finished",
      sessionId,
      turnId,
      turnNumber,
      iterationId,
      iterationNumber: 1,
      eventSequence: sequence,
      timestamp: timestamp(sequence),
      data: {
        attemptNumber: 1,
        maxAttempts: 2,
        output: {
          message: { role: "assistant", toolCalls: [call] },
          usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
        },
      },
    });
    await view.waitUntilRenderFlush();

    sequence += 1;
    await store.append({
      type: "tool.started",
      ...call,
      eventSequence: sequence,
      timestamp: timestamp(sequence),
      data: { call },
    });
    await view.waitUntilRenderFlush();

    const preview = Array.from(
      { length: 30 },
      (_, index) => `large live output ${index + 1}`,
    ).join("\n");
    sequence += 1;
    await store.append({
      type: "tool.raw_result",
      ...call,
      eventSequence: sequence,
      timestamp: timestamp(sequence),
      data: {
        call,
        raw: {
          kind: "bash",
          ok: true,
          command: "printf large-output",
          taskId: "live-tool-task",
          sessionId,
          status: "completed",
          exitCode: 0,
          cwd: "/tmp/tinker",
          outputFilePath: "/tmp/live-tool-task.log",
          outputBytes: Buffer.byteLength(preview),
          outputLines: 30,
          preview,
          truncated: false,
          tty: false,
        },
      },
    });
    await view.waitUntilRenderFlush();

    sequence += 1;
    await store.append({
      type: "tool.finished",
      ...call,
      eventSequence: sequence,
      timestamp: timestamp(sequence),
      data: { call, ok: true },
    });
    await view.waitUntilRenderFlush();

    const liveWrites = output.since(mark);
    expect(liveWrites).toContain("Background tasks");
    expect(liveWrites).toContain("large live output");
    expect(liveWrites).not.toContain("\u001b[3J");
    expect(liveWrites).not.toContain(historySentinel);
  } finally {
    view.unmount();
    await view.waitUntilExit();
  }
});

function controller(store: TuiProjectionStore): TuiSessionController {
  const runtime = createTestRuntime();
  const askUser = Object.freeze({});
  const binding: TuiSessionBinding = {
    sessionId,
    modelName: "test-model",
    workspaceRoot: "/tmp/tinker",
    projectionStore: store,
    skills: () => ({ skills: [], shadowedNames: [] }),
    mcp: () => ({ servers: [] }),
    bashGuard: () => testBashGuard,
    subscribeBashGuard: () => () => undefined,
    setYoloMode: () => undefined,
    resolveBashConfirmation: async () => undefined,
    askUser: () => askUser,
    subscribeAskUser: () => () => undefined,
    resolveAskUser: async () => undefined,
    executeTurn: async () => ({
      status: "completed",
      finalText: "done",
      lastIteration: runtime.iteration,
    }),
  };
  return {
    getBinding: () => binding,
    subscribe: () => () => undefined,
    listSessions: async () => [],
    compact: async () => {
      throw new Error("not used");
    },
    retire: async () => {
      throw new Error("not used");
    },
    undo: async () => ({ status: "nothing" }),
    fork: async () => {
      throw new Error("not used");
    },
    clear: async () => {
      throw new Error("not used");
    },
    resume: async () => {
      throw new Error("not used");
    },
    delete: async () => {
      throw new Error("not used");
    },
    switchModel: async () => {
      throw new Error("not used");
    },
  };
}

function turnStarted(
  eventSequence: number,
  turnNumber: number,
  prompt: string,
): AgentEvent {
  return {
    type: "turn.started",
    sessionId,
    turnId: `turn-${turnNumber}` as TurnId,
    turnNumber,
    eventSequence,
    timestamp: timestamp(eventSequence),
    data: {
      userPrompt: {
        version: 1,
        text: prompt,
        images: [],
        omittedImageCount: 0,
      },
    },
  };
}

function turnFinished(
  eventSequence: number,
  turnNumber: number,
  finalText: string,
): AgentEvent {
  return {
    type: "turn.finished",
    sessionId,
    turnId: `turn-${turnNumber}` as TurnId,
    turnNumber,
    eventSequence,
    timestamp: timestamp(eventSequence),
    data: {
      status: "completed",
      finalText,
      lastIteration: {
        sessionId,
        turnId: `turn-${turnNumber}` as TurnId,
        turnNumber,
        iterationId: `turn-${turnNumber}-iteration-1` as IterationId,
        iterationNumber: 1,
      },
      messageCount: 2,
    },
  };
}

function bashCall(turnNumber: number, iterationId: IterationId): ToolCall {
  return {
    sessionId,
    turnId: `turn-${turnNumber}` as TurnId,
    turnNumber,
    iterationId,
    iterationNumber: 1,
    toolCallId: `turn-${turnNumber}-iteration-1-tool-1` as ToolCallId,
    toolCallNumber: 1,
    providerToolCallId: "static-history-live-tool",
    name: "Bash",
    args: {
      command: "printf large-output",
      description: "Exercise static history live tail",
    },
  };
}

function backgroundTask(
  turnNumber: number,
  iterationId: IterationId,
  index: number,
): ShellTaskSnapshot {
  const origin: ToolCall = {
    ...bashCall(turnNumber, iterationId),
    toolCallId: `turn-${turnNumber}-iteration-1-tool-${index + 1}` as ToolCallId,
    toolCallNumber: index + 1,
    providerToolCallId: `background-${index}`,
  };
  return {
    taskId: `background-task-${index}`,
    origin,
    command: `sleep ${index}`,
    description: `Background task ${index}`,
    status: "running",
    startedAt: timestamp(index),
    backgroundedAt: timestamp(index),
    backgroundReason: "requested",
    outputFilePath: `/tmp/background-task-${index}.log`,
    outputBytes: 0,
    outputLines: 0,
    cwd: "/tmp/tinker",
    tty: false,
  };
}

function timestamp(sequence: number): string {
  return new Date(Date.UTC(2026, 6, 28, 0, 0, sequence)).toISOString();
}

class CapturedTtyOutput extends Writable {
  readonly isTTY = true;
  readonly chunks: string[] = [];

  constructor(
    readonly rows: number,
    readonly columns: number,
  ) {
    super();
  }

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  mark(): number {
    return this.chunks.length;
  }

  since(mark: number): string {
    return this.chunks.slice(mark).join("");
  }

  text(): string {
    return this.chunks.join("");
  }
}

class TestTtyInput extends Readable {
  readonly isTTY = true;
  isRaw = false;

  override _read(): void {}

  setRawMode(isRaw: boolean): this {
    this.isRaw = isRaw;
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}
