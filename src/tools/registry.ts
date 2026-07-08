import { createBashToolExecutor } from "./bash";
import { ShellTaskManager } from "./bash-task";
import { createCwdState } from "./cwd-state";
import { createEditToolExecutor } from "./edit";
import { createGlobToolExecutor } from "./glob";
import { createGrepToolExecutor } from "./grep";
import { createReadToolExecutor } from "./read";
import { createWriteToolExecutor } from "./write";
import { createUuidV7 } from "../ids/uuid-v7";
import type {
  ReadSnapshotStore,
  ToolDefinition,
  ToolExecutor,
  ToolRawResult,
} from "./types";
import type { ToolCall } from "../agent/types";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolExecutor>();

  register(tool: ToolExecutor): void {
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

  async execute(call: ToolCall): Promise<ToolRawResult> {
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
      return await tool.execute(call.args, call);
    } catch (error) {
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
};

export type BashToolingState = {
  cwd: string;
  tasks: ShellTaskManager["tasks"];
  runId: string;
  workspaceRoot: string;
};

export function createDefaultTooling(options: {
  workspaceRoot: string;
  runId?: string;
  maxDisplayedBytes?: number;
}): DefaultTooling {
  const snapshots: ReadSnapshotStore = new Map();
  const registry = new ToolRegistry();
  const runId = options.runId ?? createUuidV7();
  const cwdState = createCwdState(options.workspaceRoot);
  const taskManager = new ShellTaskManager({
    workspaceRoot: options.workspaceRoot,
    runId,
    cwdState,
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
      runId,
      cwdState,
      taskManager,
    }),
  );

  return {
    registry,
    runtime: new ToolRuntime(registry),
    snapshots,
    bashState: {
      get cwd() {
        return cwdState.cwd;
      },
      set cwd(value: string) {
        cwdState.cwd = value;
      },
      tasks: taskManager.tasks,
      runId,
      workspaceRoot: options.workspaceRoot,
    },
  };
}
