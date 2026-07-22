import { createBashToolExecutor } from "./bash";
import { ShellTaskManager } from "./bash-task";
import { createCwdState } from "./cwd-state";
import { createEditToolExecutor } from "./edit";
import { createGlobToolExecutor } from "./glob";
import { createGrepToolExecutor } from "./grep";
import { createReadToolExecutor } from "./read";
import { createRecallToolExecutor } from "./recall";
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
  FileSnapshotStore,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutor,
  ToolRawResult,
} from "./types";
import type { ToolCall } from "../agent/types";
import type { SessionHistoryReader } from "../session/session-history-reader";
import { ToolExecutionFatalError } from "./types";
import type { SkillCatalogSnapshot } from "../skills/skill-loader";
import type { SkillActivationCoordinator } from "../skills/skill-context";
import { createSkillToolExecutor } from "../skills/skill-tool";
import {
  DEFAULT_PUBLIC_TOOLING_CONFIG,
  type PublicToolingConfig,
} from "../cli/public-config-contract";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolExecutor>();
  private readonly sources = new Map<string, string>();

  register(tool: ToolExecutor, source = "built-in"): void {
    const name = tool.definition.name;
    const existingSource = this.sources.get(name);
    if (existingSource !== undefined) {
      throw new Error(
        `Tool ${name} from ${source} conflicts with an existing registration from ${existingSource}.`,
      );
    }
    this.tools.set(name, tool);
    this.sources.set(name, source);
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
        kind: "generic",
        ok: false,
        toolName: call.name,
        error: `Invalid tool arguments JSON: ${call.argsParseError}`,
      };
    }

    const tool = this.registry.get(call.name);

    if (tool === undefined) {
      return {
        kind: "generic",
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
      if (error instanceof ToolExecutionFatalError) {
        throw error;
      }

      return {
        kind: "generic",
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
  snapshots: FileSnapshotStore;
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
  historyReader: SessionHistoryReader;
  maxReadContentBytes?: number;
  exaApiKey?: string;
  webFetchRefiner?: Refiner;
  taskStopGraceMs?: number;
  skillCatalog?: SkillCatalogSnapshot;
  skillCoordinator?: SkillActivationCoordinator;
  toolingConfig?: PublicToolingConfig;
}): DefaultTooling {
  const snapshots: FileSnapshotStore = new Map();
  const registry = new ToolRegistry();
  const runtimeSession = options.runtimeSession;
  const toolingConfig = options.toolingConfig ?? DEFAULT_PUBLIC_TOOLING_CONFIG;
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
      ripgrep: {
        command: toolingConfig.ripgrepPath,
        timeoutMs: toolingConfig.grepTimeoutMs,
        maxBufferBytes: toolingConfig.grepMaxBufferBytes,
      },
    }),
  );
  registry.register(
    createReadToolExecutor({
      workspaceRoot: options.workspaceRoot,
      snapshots,
      maxContentBytes: options.maxReadContentBytes,
    }),
  );
  registry.register(createRecallToolExecutor({ historyReader: options.historyReader }));
  if (options.skillCatalog !== undefined) {
    if (options.skillCatalog.skills.size === 0) {
      throw new Error("An empty Agent Skill catalog must not register tooling.");
    }
    if (options.skillCoordinator === undefined) {
      throw new Error("Agent Skill tooling requires an activation coordinator.");
    }
    registry.register(
      createSkillToolExecutor({
        catalog: options.skillCatalog,
        coordinator: options.skillCoordinator,
      }),
    );
  } else if (options.skillCoordinator !== undefined) {
    throw new Error("Agent Skill coordinator was provided without a catalog.");
  }
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
      defaultTimeoutMs: toolingConfig.bashDefaultTimeoutMs,
      maxTimeoutMs: toolingConfig.bashMaxTimeoutMs,
    }),
  );
  registry.register(createTaskListToolExecutor({ taskManager }));
  registry.register(createTaskOutputToolExecutor({ taskManager }));
  registry.register(createTaskStopToolExecutor({ taskManager }));

  const exaApiKey = options.exaApiKey ?? toolingConfig.exaApiKey;
  const hasExaKey = exaApiKey !== undefined && exaApiKey.trim() !== "";

  if (hasExaKey) {
    registry.register(createWebSearchToolExecutor({ apiKey: exaApiKey }));
  }

  registry.register(
    createWebFetchToolExecutor({
      exaApiKey: hasExaKey ? exaApiKey : undefined,
      refiner: options.webFetchRefiner,
      refineThreshold: toolingConfig.webFetchRefineThreshold,
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
