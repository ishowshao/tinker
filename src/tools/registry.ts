import { createBashToolExecutor } from "./bash";
import { ShellTaskManager } from "./bash-task";
import { createCwdState } from "./cwd-state";
import { createEditToolExecutor } from "./edit";
import { createGlobToolExecutor } from "./glob";
import { createGrepToolExecutor } from "./grep";
import { createReadToolExecutor } from "./read";
import { createTaskListToolExecutor } from "./task-list";
import { createTaskOutputToolExecutor } from "./task-output-tool";
import { createTaskStopToolExecutor } from "./task-stop";
import { createWebFetchToolExecutor } from "./web-fetch";
import type { Refiner } from "./web-fetch/refiner";
import { createWebSearchToolExecutor } from "./web-search";
import { createWriteToolExecutor } from "./write";
import { cancellationError, throwIfTurnCancelled } from "../agent/turn-cancellation";
import type {
  RuntimeSessionContext,
  SessionDisposeReason,
} from "../agent/runtime-session";
import type {
  ReadSnapshotStore,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutor,
  ToolRawResult,
} from "./types";
import type { ToolCall } from "../agent/types";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolExecutor>();

  register(tool: ToolExecutor): void {
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`Tool already registered: ${tool.definition.name}.`);
    }
    this.tools.set(tool.definition.name, tool);
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  get(name: string): ToolExecutor | undefined {
    return this.tools.get(name);
  }
}

export class ToolRuntime {
  constructor(private readonly registry: ToolRegistry) {}

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolRawResult> {
    throwIfTurnCancelled(context.signal);

    if (call.argsParseError !== undefined) {
      return {
        ok: false,
        toolName: call.name,
        error: `Invalid tool arguments JSON: ${call.argsParseError}`,
      };
    }

    const tool = this.registry.get(call.name);

    if (tool === undefined) {
      return {
        ok: false,
        toolName: call.name,
        error: `Unknown tool: ${call.name}`,
      };
    }

    try {
      return await tool.execute(call.args, call, context);
    } catch (error) {
      if (context.signal.aborted) {
        throw cancellationError(context.signal, error);
      }

      return {
        ok: false,
        toolName: call.name,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export type DefaultTooling = {
  registry: ToolRegistry;
  runtime: ToolRuntime;
  snapshots: ReadSnapshotStore;
  bashState: BashToolingState;
  taskManager: ShellTaskManager;
  dispose(reason?: SessionDisposeReason["type"]): Promise<void>;
};

export type BashToolingState = {
  cwd: string;
  sessionId: string;
  workspaceRoot: string;
};

export function createDefaultTooling(options: {
  workspaceRoot: string;
  runtimeSession: RuntimeSessionContext;
  maxDisplayedBytes?: number;
  exaApiKey?: string;
  webFetchRefiner?: Refiner;
  taskStopGraceMs?: number;
}): DefaultTooling {
  const snapshots: ReadSnapshotStore = new Map();
  const registry = new ToolRegistry();
  const runtimeSession = options.runtimeSession;
  const cwdState = createCwdState(options.workspaceRoot);
  const taskManager = new ShellTaskManager({
    workspaceRoot: options.workspaceRoot,
    cwdState,
    runtimeSession,
    stopGraceMs: options.taskStopGraceMs,
  });

  registry.register(
    createGlobToolExecutor({
      workspaceRoot: options.workspaceRoot,
    }),
  );
  registry.register(
    createGrepToolExecutor({
      workspaceRoot: options.workspaceRoot,
      cwdState,
    }),
  );
  registry.register(
    createReadToolExecutor({
      workspaceRoot: options.workspaceRoot,
      snapshots,
      maxDisplayedBytes: options.maxDisplayedBytes,
    }),
  );
  registry.register(
    createWriteToolExecutor({
      workspaceRoot: options.workspaceRoot,
      snapshots,
    }),
  );
  registry.register(
    createEditToolExecutor({
      workspaceRoot: options.workspaceRoot,
      snapshots,
    }),
  );
  registry.register(
    createBashToolExecutor({
      workspaceRoot: options.workspaceRoot,
      cwdState,
      taskManager,
    }),
  );
  registry.register(createTaskListToolExecutor({ taskManager }));
  registry.register(createTaskOutputToolExecutor({ taskManager }));
  registry.register(createTaskStopToolExecutor({ taskManager }));

  const exaApiKey = options.exaApiKey ?? process.env.EXA_API_KEY;
  const hasExaKey = exaApiKey !== undefined && exaApiKey.trim() !== "";

  if (hasExaKey) {
    registry.register(createWebSearchToolExecutor({ apiKey: exaApiKey }));
  }

  registry.register(
    createWebFetchToolExecutor({
      exaApiKey: hasExaKey ? exaApiKey : undefined,
      refiner: options.webFetchRefiner,
    }),
  );

  return {
    registry,
    runtime: new ToolRuntime(registry),
    snapshots,
    taskManager,
    bashState: {
      get cwd() {
        return cwdState.cwd;
      },
      set cwd(value: string) {
        cwdState.cwd = value;
      },
      sessionId: runtimeSession.sessionId,
      workspaceRoot: options.workspaceRoot,
    },
    async dispose(reason = "oneshot_complete") {
      await taskManager.shutdown(reason);
    },
  };
}
