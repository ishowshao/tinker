import { createBashToolExecutor } from "./bash";
import { ShellTaskManager } from "./bash-task";
import { createCwdState } from "./cwd-state";
import {
  createContextStatusToolExecutor,
  createContextSwapCandidatesToolExecutor,
  createContextSwapToolExecutor,
} from "./context-maintenance";
import { createDeleteToolExecutor } from "./delete";
import { createEditToolExecutor } from "./edit";
import { createGlobToolExecutor } from "./glob";
import { createGrepToolExecutor } from "./grep";
import { createReadToolExecutor } from "./read";
import { createRecallGetToolExecutor, createRecallSearchToolExecutor } from "./recall";
import { createTaskListToolExecutor } from "./task-list";
import { createTaskInputToolExecutor } from "./task-input";
import { createTaskOutputToolExecutor } from "./task-output-tool";
import { createTaskStopToolExecutor } from "./task-stop";
import { createUpdatePlanToolExecutor } from "./update-plan";
import { createWaitToolExecutor } from "./wait";
import { createWebFetchToolExecutor } from "./web-fetch";
import type { Refiner } from "./web-fetch/refiner";
import { createWebSearchToolExecutor } from "./web-search";
import { createWriteToolExecutor } from "./write";
import { createViewImageToolExecutor } from "./view-image";
import { TurnUndoManager } from "./turn-undo-manager";
import { cancellationError, throwIfTurnCancelled } from "../agent/turn-cancellation";
import type {
  RuntimeSessionContext,
  SessionDisposeReason,
} from "../agent/runtime-session";
import type {
  FileSnapshotStore,
  ContextMaintenanceHandle,
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
import type { ImageAssetStore } from "../image/image-asset-store";

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
  constructor(
    private readonly registry: ToolRegistry,
    private readonly bashGuard?: {
      readonly surface: "tui" | "one-shot";
      confirm(
        call: ToolCall,
        request: { command: string; reason: string },
        signal: AbortSignal,
      ): Promise<"allow" | "deny">;
    },
    private readonly contextMaintenance?: ContextMaintenanceHandle,
  ) {}

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
      return await tool.execute(call.args, call, {
        ...context,
        ...(this.contextMaintenance === undefined
          ? {}
          : { contextMaintenance: this.contextMaintenance }),
        ...(this.bashGuard === undefined
          ? {}
          : {
              bashGuardSurface: this.bashGuard.surface,
              confirmBashCommand: (request: { command: string; reason: string }) =>
                this.bashGuard!.confirm(call, request, context.signal),
            }),
      });
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
  turnUndoManager?: TurnUndoManager;
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
  homeRoot?: string;
  maxReadContentBytes?: number;
  exaApiKey?: string;
  webFetchRefiner?: Refiner;
  taskStopGraceMs?: number;
  skillCatalog?: SkillCatalogSnapshot;
  skillCoordinator?: SkillActivationCoordinator;
  toolingConfig?: PublicToolingConfig;
  memorySearch?: ToolExecutor;
  memoryGet?: ToolExecutor;
  enableTurnUndo?: boolean;
  imageAssetStore?: ImageAssetStore;
  supportsViewImage?: boolean;
  bashGuard?: {
    readonly surface: "tui" | "one-shot";
    confirm(
      call: ToolCall,
      request: { command: string; reason: string },
      signal: AbortSignal,
    ): Promise<"allow" | "deny">;
  };
}): DefaultTooling {
  const snapshots: FileSnapshotStore = new Map();
  const turnUndoManager = options.enableTurnUndo
    ? new TurnUndoManager({ snapshots })
    : undefined;
  const registry = new ToolRegistry();
  const runtimeSession = options.runtimeSession;
  const toolingConfig = options.toolingConfig ?? DEFAULT_PUBLIC_TOOLING_CONFIG;
  const cwdState = createCwdState(options.workspaceRoot);
  const taskManager = new ShellTaskManager({
    workspaceRoot: options.workspaceRoot,
    cwdState,
    runtimeSession,
    stopGraceMs: options.taskStopGraceMs,
    ...(options.homeRoot === undefined ? {} : { homeRoot: options.homeRoot }),
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
  if (options.supportsViewImage === true) {
    if (options.imageAssetStore === undefined) {
      throw new Error("ViewImage tooling requires an image asset store.");
    }
    registry.register(
      createViewImageToolExecutor({ imageAssetStore: options.imageAssetStore }),
    );
  }
  registry.register(
    createRecallSearchToolExecutor({ historyReader: options.historyReader }),
  );
  registry.register(
    createRecallGetToolExecutor({ historyReader: options.historyReader }),
  );
  registry.register(createContextStatusToolExecutor());
  registry.register(createContextSwapCandidatesToolExecutor());
  registry.register(createContextSwapToolExecutor());
  if (options.memorySearch !== undefined) {
    registry.register(options.memorySearch);
  }
  if (options.memoryGet !== undefined) {
    registry.register(options.memoryGet);
  }
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
      ...(turnUndoManager === undefined ? {} : { undoManager: turnUndoManager }),
    }),
  );
  registry.register(
    createEditToolExecutor({
      workspaceRoot: options.workspaceRoot,
      snapshots,
      ...(turnUndoManager === undefined ? {} : { undoManager: turnUndoManager }),
    }),
  );
  registry.register(
    createDeleteToolExecutor({
      workspaceRoot: options.workspaceRoot,
      snapshots,
      ...(turnUndoManager === undefined ? {} : { undoManager: turnUndoManager }),
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
  registry.register(createUpdatePlanToolExecutor());
  registry.register(createWaitToolExecutor());
  registry.register(createTaskListToolExecutor({ taskManager }));
  registry.register(createTaskOutputToolExecutor({ taskManager }));
  registry.register(createTaskInputToolExecutor({ taskManager }));
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
    runtime: new ToolRuntime(
      registry,
      options.bashGuard,
      options.runtimeSession.contextMaintenance,
    ),
    snapshots,
    taskManager,
    ...(turnUndoManager === undefined ? {} : { turnUndoManager }),
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
