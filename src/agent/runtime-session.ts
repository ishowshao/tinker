import path from "node:path";
import { assertContextMaintenanceCapabilities } from "./runtime-context-capabilities";
import { CompiledContextError } from "../context/compiled-context-validator";
import {
  DEFAULT_CONTEXT_AUTOMATION_POLICY,
  type ContextAutomationPolicy,
} from "../context/context-automation-policy";
import {
  ContextManager,
  type ContextCompactionResult,
  type ContextRetirementResult,
} from "../context/context-manager";
import { ContextProtocolError } from "../context/context-protocol-validator";
import type { BuiltContextRequest } from "../context/context-revision";
import { ContextRevisionError } from "../context/context-revision-compiler";
import { createContextSurface } from "../context/context-surface";
import { CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION } from "../context/recall-retirement-contract";
import { SwapPlanner } from "../context/swap-planner";
import { CompositeEventSink } from "../events/composite-event-sink";
import type { EventSink } from "../events/event-sink";
import { JsonlEventLog } from "../events/jsonl-event-log";
import { ObservationTextLog } from "../events/observation-text-log";
import type { AgentEvent, AgentEventInput } from "../events/types";
import { runtimeIdFactory, type SessionId, type TurnId } from "../ids/runtime-id";
import { ImageAssetStore, type ImportedImageAsset } from "../image/image-asset-store";
import { IMAGE_INPUT_POLICY } from "../image/image-input-policy";
import {
  validateUserMessage,
  type ImageAssetRef,
  type UserMessage,
} from "../image/image-types";
import { loadMcpConfig } from "../mcp/mcp-config";
import {
  createMcpManager,
  type McpInventorySnapshot,
  type McpManager,
} from "../mcp/mcp-manager";
import { CommittedPrefixAuditor } from "../model/committed-prefix-auditor";
import {
  materializeModelRequest,
  ModelRequestMediaAggregateError,
  type MaterializedModelRequest,
} from "../model/model-client";
import { assertMatchingContextBudget } from "../model/model-context-profile";
import type { ReasoningEffortSnapshot } from "../model/reasoning-effort";
import { ObservationBuilder } from "../observation/observation-builder";
import { SessionError } from "../session/session-errors";
import {
  createSessionCompatibilityContract,
  SessionStore,
  type CompletedTurnSnapshot,
  type SessionRecoveryResult,
  type StoredSkillActivation,
} from "../session/session-store";
import { SqliteSessionLedger } from "../session/sqlite-session-ledger";
import {
  createSkillCatalogSnapshot,
  skillCatalogManifest,
} from "../skills/skill-catalog";
import {
  buildActiveSystemPrompt,
  rebindActiveSkills,
  SkillActivationCoordinator,
} from "../skills/skill-context";
import type { SkillCatalogSnapshot } from "../skills/skill-loader";
import { createDefaultTooling, type DefaultTooling } from "../tools/registry";
import type { TurnUndoResult } from "../tools/turn-undo-manager";
import { ToolExecutionFatalError, type AskUserRequest } from "../tools/types";
import type { AssistantTextDeltaUpdate } from "./assistant-text-delta";
import { ContextMeter } from "./context-meter";
import { FatalAgentTurnError, runAgent, type RunAgentInput } from "./loop";
import { assertPreparedMatchesSurface } from "./runtime-context-events";
import { RuntimeContextMaintenance } from "./runtime-context-maintenance";
import { RuntimeInteractions } from "./runtime-interactions";
import { RuntimePromptScheduler } from "./runtime-prompt-scheduler";
import {
  RuntimeEventAppendError,
  type AcceptedTurn,
  type AskUserResolution,
  type AskUserSnapshot,
  type BashGuardSnapshot,
  type CompletedTurnHook,
  type CompletedTurnHookFailure,
  type CreateNewRuntimeSessionInput,
  type CreateRuntimeSessionInput,
  type ExecuteTurnInput,
  type PromptSchedulerSnapshot,
  type QueueFollowUpResult,
  type RuntimeSession,
  type RuntimeSessionContext,
  type RuntimeSessionFactoryDependencies,
  type RuntimeSessionState,
  type RuntimeSkillsSnapshot,
  type SessionDisposeReason,
  type SkillsUpdateSummary,
} from "./runtime-session-contracts";
import { RuntimeSkills } from "./runtime-skills";
import {
  AdmissionStaleError,
  SessionLedgerWriteError,
  type AdmissionBaseToken,
  type AgentTurnLedger,
  type SessionLedger,
} from "./session-ledger";
import { TurnCancelledError } from "./turn-cancellation";
import type {
  IterationIdentity,
  RunAgentResult,
  ToolCall,
  ToolCallIdentity,
  TurnIdentity,
} from "./types";
import { projectUserMessage } from "./user-prompt-projection";

export {
  RuntimeEventAppendError,
  type AcceptedTurn,
  type AskUserResolution,
  type AskUserSnapshot,
  type BashGuardSnapshot,
  type BashGuardSource,
  type CompletedTurnHook,
  type CompletedTurnHookFailure,
  type CompletedTurnHookInput,
  type ContextSurfaceRefreshSummary,
  type CreateRuntimeSessionInput,
  type ExecuteTurnInput,
  type PromptSchedulerSnapshot,
  type QueueFollowUpResult,
  type RuntimeSession,
  type RuntimeSessionContext,
  type RuntimeSessionFactoryDependencies,
  type RuntimeSkillsSnapshot,
  type SessionDisposeReason,
  type SkillsUpdateSummary,
} from "./runtime-session-contracts";

const EMPTY_MCP_INVENTORY: McpInventorySnapshot = Object.freeze({
  servers: Object.freeze([]),
});

type ActiveTurn = {
  turn: TurnIdentity;
  ledger: AgentTurnLedger;
  consumedThroughOrdinal?: number;
  controller: AbortController;
  completion: Promise<RunAgentResult>;
};

type ActiveAdmission = {
  controller: AbortController;
  settled: Promise<void>;
  settle: () => void;
};

const defaultDependencies: RuntimeSessionFactoryDependencies = {
  idFactory: runtimeIdFactory,
  createTooling: createDefaultTooling,
  loadMcpConfig,
  createMcpManager,
  createObservationBuilder: () => new ObservationBuilder(),
  openStore: (input, idFactory) =>
    isNewSessionInput(input)
      ? SessionStore.createNew({
          workspaceRoot: input.workspaceRoot,
          sessionId: input.selection.sessionId,
          modelName: input.modelName,
          systemPrompt: input.systemPrompt,
          projectInstruction: input.projectInstruction,
          idFactory,
          ...(input.homeRoot === undefined ? {} : { homeRoot: input.homeRoot }),
        })
      : SessionStore.openExisting({
          workspaceRoot: input.workspaceRoot,
          sessionId: input.selection.sessionId,
          ...(input.homeRoot === undefined ? {} : { homeRoot: input.homeRoot }),
        }),
  createLedger: (store, idFactory) => new SqliteSessionLedger(store, idFactory),
  createEventSink,
  selectShadowPlanning: ({ preflight }) =>
    preflight.pressure === "normal" ? undefined : { trigger: "runtime_pressure" },
  contextAutomationPolicy: DEFAULT_CONTEXT_AUTOMATION_POLICY,
  automaticCompactionTrigger: () => ({ kind: "runtime_pressure" }),
  automaticRetirementTrigger: () => ({ kind: "runtime_pressure" }),
  manualCompactionTrigger: () => ({ kind: "manual" }),
  manualRetirementTrigger: () => ({ kind: "manual" }),
};

class DefaultRuntimeSession implements RuntimeSession {
  readonly sessionId: SessionId;
  readonly resumed: boolean;
  recovery: SessionRecoveryResult = {
    syntheticCompletionCount: 0,
    recallIndexRebuilt: false,
  };

  private state: RuntimeSessionState = "initializing";
  private nextTurnNumber: number;
  private readonly turns = new Map<string, TurnIdentity>();
  private readonly iterations = new Map<string, IterationIdentity>();
  private readonly toolCalls = new Map<string, ToolCallIdentity>();
  private readonly nextIterationNumberByTurn = new Map<string, number>();
  private readonly nextToolCallNumberByIteration = new Map<string, number>();
  private eventTail: Promise<void> = Promise.resolve();
  private tooling?: DefaultTooling;
  private mcpManager?: McpManager;
  private ledger?: SessionLedger;
  private activeAdmission?: ActiveAdmission;
  private activeTurn?: ActiveTurn;
  private activeContextRevision?: Promise<
    ContextCompactionResult | ContextRetirementResult
  >;
  private disposePromise?: Promise<void>;
  private faultCause?: unknown;
  private readonly contextMeter: ContextMeter;
  private readonly committedPrefixAuditor = new CommittedPrefixAuditor();
  private readonly shadowPlanner: SwapPlanner;
  private contextManager?: ContextManager;
  private contextAutomationPolicy?: ContextAutomationPolicy;
  private assistantTextDeltaSinkDisabled = false;

  private readonly skillCatalog: SkillCatalogSnapshot;
  private readonly interactions: RuntimeInteractions;
  private readonly scheduler: RuntimePromptScheduler;
  private readonly contextMaintenance: RuntimeContextMaintenance;
  private readonly runtimeSkills: RuntimeSkills;
  private readonly context: RuntimeSessionContext;

  private constructor(
    private readonly input: CreateRuntimeSessionInput,
    private readonly dependencies: RuntimeSessionFactoryDependencies,
    private readonly eventSink: EventSink,
    private readonly observationBuilder: ObservationBuilder,
    private readonly store: SessionStore,
    private readonly assetStore: ImageAssetStore,
  ) {
    this.sessionId = input.selection.sessionId;
    this.resumed = input.selection.mode === "resume";
    this.scheduler = new RuntimePromptScheduler(
      () => this.state,
      () => this.activeTurn,
      (input) => this.admitSingleTurn(input),
      (event) => this.append(event),
    );
    this.interactions = new RuntimeInteractions(input.bashGuard, (event) =>
      this.append(event),
    );
    this.skillCatalog =
      input.skillCatalog ??
      createSkillCatalogSnapshot({
        workspaceRoot: input.workspaceRoot,
        homeRoot: input.workspaceRoot,
        skills: [],
        shadowed: [],
      });
    this.nextTurnNumber = store.nextTurnNumber();
    this.contextMeter = new ContextMeter(input.contextBudget, {
      onMeasuredAnchor: (anchor) => store.writeMeasuredContextAnchor(anchor),
    });
    this.shadowPlanner = new SwapPlanner(input.modelClient);
    this.contextMaintenance = new RuntimeContextMaintenance(
      this.sessionId,
      store,
      () => this.requireContextManager(),
      () => this.requireContextAutomation(),
      (call, expectedName) => this.requireActiveContextTool(call, expectedName),
      (event) => this.append(event),
      {
        getState: () => this.state,
        setState: (state) => {
          this.state = state;
        },
        hasActiveTurn: () => this.activeTurn !== undefined,
        fault: (error) => this.fault(error),
      },
      dependencies,
    );
    this.runtimeSkills = new RuntimeSkills(
      this.sessionId,
      store,
      input,
      this.skillCatalog,
      dependencies.idFactory,
      this.contextMeter,
      () => this.requireTooling().registry.definitions(),
      (event) => this.append(event),
    );
    this.context = {
      sessionId: this.sessionId,
      contextMaintenance: {
        status: (call) => this.contextMaintenance.contextStatus(call),
        candidates: (call, page) =>
          this.contextMaintenance.contextSwapCandidates(call, page),
        swap: (call, selection) => this.contextMaintenance.contextSwap(call, selection),
      },
      createIteration: (turn, iterationNumber) =>
        this.createIteration(turn, iterationNumber),
      createToolCall: (iteration, toolCallNumber) =>
        this.createToolCall(iteration, toolCallNumber),
      finishIterationForContinuation: (iteration) =>
        this.finishIterationForContinuation(iteration),
      append: (event) => this.append(event),
      ...(input.assistantTextDeltaSink === undefined
        ? {}
        : {
            updateAssistantTextDelta: (update: AssistantTextDeltaUpdate) =>
              this.updateAssistantTextDelta(update),
          }),
      onToolCompletionsCommitted: (completion) =>
        this.runtimeSkills.onToolCompletionsCommitted(completion),
      prepareModelDispatch: (dispatch) => this.prepareModelDispatch(dispatch),
      maintainContextAfterIteration: (maintenance) =>
        this.contextMaintenance.performActiveTurnContextMaintenance(maintenance),
      applyQueuedSteering: (steering) => this.scheduler.applyQueuedSteering(steering),
    };
  }

  static async create(
    input: CreateRuntimeSessionInput,
    dependencies: RuntimeSessionFactoryDependencies,
  ): Promise<RuntimeSession> {
    validateCreateInput(input);
    const store = await dependencies.openStore(input, dependencies.idFactory);
    let assetStore: ImageAssetStore;
    try {
      assetStore = await ImageAssetStore.open({
        workspaceRoot: store.workspaceRoot,
        ...(input.homeRoot === undefined ? {} : { homeRoot: input.homeRoot }),
      });
    } catch (error) {
      if (isNewSessionInput(input)) {
        await store
          .deleteFromDisk()
          .catch(() => store.abandon().catch(() => undefined));
      } else {
        await store.abandon().catch(() => undefined);
      }
      throw error;
    }
    let session: DefaultRuntimeSession;
    try {
      session = new DefaultRuntimeSession(
        input,
        dependencies,
        dependencies.createEventSink(input, store.sessionDirectory),
        dependencies.createObservationBuilder(),
        store,
        assetStore,
      );
    } catch (error) {
      if (isNewSessionInput(input)) {
        await store
          .deleteFromDisk()
          .catch(() => store.abandon().catch(() => undefined));
      } else {
        await store.abandon().catch(() => undefined);
      }
      throw error;
    }
    let started = false;

    try {
      const compatibility = createSessionCompatibilityContract({
        modelName: input.modelName,
        profileName: input.profileName,
        includeReasoningContent: input.includeReasoningContent,
        contextProfile: input.contextProfile,
        messageProtocol: input.modelClient.messageProtocol,
        inputModalities: input.modelClient.inputModalities,
        toolResultModalities: input.modelClient.toolResultModalities,
      });
      if (input.selection.mode === "resume") {
        store.assertSessionCompatibility(compatibility);
      }

      let resumeSkills:
        | {
            unresolved: readonly StoredSkillActivation[];
            activated: readonly string[];
            refreshed: readonly string[];
            deactivated: readonly string[];
          }
        | undefined;
      if (input.selection.mode === "resume") {
        session.recovery = store.recoverInterruptedState(dependencies.idFactory);
        const storedSurface = store.loadContextSnapshot().surface;
        const unresolved = store.loadSkillActivations(["pending", "dispatched"]);
        const promotionNames = unresolved
          .filter((activation) => activation.state === "dispatched")
          .map((activation) => ({
            name: activation.name,
            activationMessageId: activation.activationMessageId,
          }));
        const rebound = rebindActiveSkills({
          catalog: session.skillCatalog,
          active: storedSurface.activeSkills,
          promotionNames,
        });
        session.runtimeSkills.restoreCoordinator(
          new SkillActivationCoordinator({ active: rebound.active }),
        );
        const activated = promotionNames
          .filter((entry) => session.skillCatalog.skills.has(entry.name))
          .map((entry) => entry.name)
          .sort();
        resumeSkills = {
          unresolved,
          activated: Object.freeze(activated),
          refreshed: Object.freeze(
            rebound.refreshed.filter((name) => !activated.includes(name)).sort(),
          ),
          deactivated: rebound.deactivated,
        };
      }

      if (isNewSessionInput(input)) {
        await session.append({
          type: "session.started",
          sessionId: session.sessionId,
          data: {
            workspaceRoot: store.workspaceRoot,
            model: input.modelName,
            ...(input.profileName === undefined
              ? {}
              : { profileName: input.profileName }),
            maxIterations: input.maxIterations,
            includeReasoningContent: input.includeReasoningContent,
            contextProfile: input.contextProfile,
            contextBudget: input.contextBudget,
            projectInstructions: {
              ...(input.projectInstruction === undefined
                ? {}
                : { instruction: input.projectInstruction }),
            },
          },
        });
        started = true;
      }

      session.tooling = dependencies.createTooling({
        workspaceRoot: store.workspaceRoot,
        ...(input.homeRoot === undefined ? {} : { homeRoot: input.homeRoot }),
        runtimeSession: session.context,
        historyReader: store.historyReader(),
        imageAssetStore: assetStore,
        supportsViewImage:
          input.modelClient.inputModalities.includes("image") &&
          input.modelClient.toolResultModalities.includes("image"),
        ...(input.enableTurnUndo === true ? { enableTurnUndo: true } : {}),
        webFetchRefiner: input.webFetchRefiner,
        toolingConfig: input.toolingConfig,
        ...(input.enableAskUser === true
          ? {
              askUser: (
                call: ToolCallIdentity,
                request: AskUserRequest,
                signal: AbortSignal,
              ) => session.interactions.requestUserAnswer(call, request, signal),
            }
          : {}),
        bashGuard: {
          surface: input.bashGuard?.surface ?? "one-shot",
          confirm: (call, request, signal) =>
            session.interactions.confirmBashCommand(call, request, signal),
        },
        ...(input.memorySearch === undefined
          ? {}
          : { memorySearch: input.memorySearch }),
        ...(input.memoryGet === undefined ? {} : { memoryGet: input.memoryGet }),
        ...(input.memoryCreate === undefined
          ? {}
          : { memoryCreate: input.memoryCreate }),
        ...(input.memoryUpdate === undefined
          ? {}
          : { memoryUpdate: input.memoryUpdate }),
        ...(input.memoryDelete === undefined
          ? {}
          : { memoryDelete: input.memoryDelete }),
        ...(session.skillCatalog.skills.size === 0
          ? {}
          : {
              skillCatalog: session.skillCatalog,
              skillCoordinator: session.runtimeSkills.coordinator,
            }),
      });

      const mcpConfig = await dependencies.loadMcpConfig(input.workspaceRoot);
      if (mcpConfig !== undefined) {
        session.mcpManager = await dependencies.createMcpManager({
          config: mcpConfig,
          workspaceRoot: input.workspaceRoot,
          runtimeSession: session.context,
          timeoutMs: input.toolingConfig?.mcpTimeoutMs,
          maxObservationChars: input.toolingConfig?.mcpMaxObservationChars,
        });
        for (const executor of session.mcpManager.executors) {
          session.tooling.registry.register(executor, "MCP");
        }
      }

      const definitions = session.requireTooling().registry.definitions();
      const activeSystemPrompt = buildActiveSystemPrompt({
        baseSystemPrompt: input.systemPrompt,
        activeSkills: session.runtimeSkills.coordinator.activeEntries(),
      });
      const surfacePrepared = input.modelClient.prepare({
        messages: [{ role: "system", content: activeSystemPrompt }],
        tools: definitions,
      });
      const candidateSurface = createContextSurface({
        surfaceId: dependencies.idFactory.createContextSurfaceId(),
        sessionId: session.sessionId,
        systemPrompt: activeSystemPrompt,
        recallContractVersion: CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION,
        ...(input.projectInstruction === undefined
          ? {}
          : { projectInstruction: input.projectInstruction }),
        skillCatalog: skillCatalogManifest(session.skillCatalog.skills.values()),
        activeSkills: session.runtimeSkills.coordinator.activeManifest(),
        toolDefinitions: definitions,
        prepared: surfacePrepared,
        createdAt: new Date().toISOString(),
      });
      if (input.selection.mode === "new") {
        store.finalizeInitialization({
          contract: compatibility,
          surface: candidateSurface,
          revisionId: dependencies.idFactory.createContextRevisionId(),
        });
      } else {
        if (resumeSkills === undefined) {
          throw new Error("Resume Agent Skills staging state is missing.");
        }
        let skillsUpdate: SkillsUpdateSummary | undefined;
        const refresh =
          resumeSkills.unresolved.length === 0
            ? await session.runtimeSkills.refreshContextSurface(candidateSurface)
            : undefined;
        if (resumeSkills.unresolved.length > 0) {
          skillsUpdate = await session.runtimeSkills.commitSkillSettlements({
            reason: "resume",
            candidateSurface,
            unresolved: resumeSkills.unresolved,
            activated: resumeSkills.activated,
            refreshed: resumeSkills.refreshed,
            deactivated: resumeSkills.deactivated,
          });
        }
        const openCount = store.markResumed();
        if (
          session.recovery.recoveredTurnId !== undefined &&
          session.recovery.recoveredFrameId !== undefined
        ) {
          await session.append({
            type: "session.interrupted_frame_recovered",
            sessionId: session.sessionId,
            data: {
              turnId: session.recovery.recoveredTurnId,
              frameId: session.recovery.recoveredFrameId,
              syntheticCompletionCount: session.recovery.syntheticCompletionCount,
            },
          });
        }
        await session.append({
          type: "session.resumed",
          sessionId: session.sessionId,
          data: {
            openCount,
            ...session.recovery,
            contextProfile: input.contextProfile,
            contextBudget: input.contextBudget,
            ...(input.projectInstruction === undefined
              ? {}
              : {
                  projectInstructionFile: input.projectInstruction.path,
                }),
            ...(refresh === undefined ? {} : { contextRefresh: refresh }),
          },
        });
        if (skillsUpdate !== undefined) {
          await session.append({
            type: "skills.updated",
            sessionId: session.sessionId,
            data: {
              reason: "resume",
              activated: skillsUpdate.activated,
              refreshed: skillsUpdate.refreshed,
              deactivated: skillsUpdate.deactivated,
              unavailable: skillsUpdate.unavailable,
              revisionNumber: skillsUpdate.revisionNumber,
            },
          });
        } else if (
          resumeSkills.refreshed.length > 0 ||
          resumeSkills.deactivated.length > 0
        ) {
          await session.append({
            type: "skills.updated",
            sessionId: session.sessionId,
            data: {
              reason: "resume",
              activated: [],
              refreshed: resumeSkills.refreshed,
              deactivated: resumeSkills.deactivated,
              unavailable: [],
              ...(refresh === undefined
                ? {}
                : { revisionNumber: refresh.revisionNumber }),
            },
          });
        }
      }

      await session.runtimeSkills.appendSkillsCatalogLoaded();

      assertContextMaintenanceCapabilities(
        session.requireTooling().registry,
        store.loadContextSnapshot().surface.recallContractVersion,
      );
      session.ledger = dependencies.createLedger(store, dependencies.idFactory);
      session.contextManager = new ContextManager({
        store,
        ledger: session.requireLedger(),
        model: input.modelClient,
        contextMeter: session.contextMeter,
        committedPrefixAuditor: session.committedPrefixAuditor,
        idFactory: dependencies.idFactory,
        tools: () => session.requireTooling().registry.definitions(),
        onUsageUpdated: (snapshot) =>
          session.append({
            type: "context.usage.updated",
            sessionId: session.sessionId,
            data: { phase: "revision", snapshot },
          }),
      });
      const initialBuilt = session
        .requireLedger()
        .buildCommittedModelRequest(definitions);
      const initialPrepared = input.modelClient.prepare(initialBuilt.request);
      assertPreparedMatchesSurface(initialPrepared, initialBuilt.surface);
      session.committedPrefixAuditor.audit(
        initialBuilt.compiled.revisionId,
        initialPrepared,
      );
      if (input.selection.mode === "resume") {
        const storedAnchor = store.readActiveMeasuredContextAnchor();
        if (storedAnchor !== undefined) {
          session.contextMeter.restoreExactMeasuredAnchor(
            initialPrepared,
            storedAnchor,
          );
        }
      }
      const initialSnapshot = session.contextMeter.measure(initialPrepared);
      await session.append({
        type: "context.usage.updated",
        sessionId: session.sessionId,
        data: { phase: "initial", snapshot: initialSnapshot },
      });

      session.contextAutomationPolicy = Object.freeze({
        ...dependencies.contextAutomationPolicy,
      });
      if (
        input.selection.mode === "resume" &&
        initialSnapshot.pressure !== "normal" &&
        session.contextAutomationPolicy.automaticSwap
      ) {
        session.contextMaintenance.scheduleAutomaticMaintenance();
        session.state = "executing";
        await session.contextMaintenance.performAutomaticContextMaintenance();
      }

      session.state = "ready";
      return session;
    } catch (error) {
      return session.rollbackInitialization(error, started);
    }
  }

  bashGuard(): BashGuardSnapshot {
    return this.interactions.bashGuard();
  }

  subscribeBashGuard(listener: () => void): () => void {
    return this.interactions.subscribeBashGuard(listener);
  }

  setYoloMode(enabled: boolean): void {
    return this.interactions.setYoloMode(enabled);
  }

  resolveBashConfirmation(decision: "allow" | "deny"): Promise<void> {
    return this.interactions.resolveBashConfirmation(decision);
  }

  askUser(): AskUserSnapshot {
    return this.interactions.askUser();
  }

  subscribeAskUser(listener: () => void): () => void {
    return this.interactions.subscribeAskUser(listener);
  }

  resolveAskUser(response: AskUserResolution): Promise<void> {
    return this.interactions.resolveAskUser(response);
  }

  skills(): RuntimeSkillsSnapshot {
    return this.runtimeSkills.skills();
  }

  mcp(): McpInventorySnapshot {
    return this.mcpManager?.inventory ?? EMPTY_MCP_INVENTORY;
  }

  supportsImageInput(): boolean {
    return this.input.modelClient.inputModalities?.includes("image") === true;
  }

  reasoningEffort(): ReasoningEffortSnapshot | undefined {
    return this.input.modelClient.reasoningEffort?.snapshot();
  }

  setReasoningEffort(effort: string): ReasoningEffortSnapshot {
    if (this.state !== "ready" || this.activeTurn !== undefined) {
      throw new Error(
        `Cannot change reasoning effort while RuntimeSession is ${this.state}.`,
      );
    }
    const reasoningEffort = this.input.modelClient.reasoningEffort;
    if (reasoningEffort === undefined) {
      throw new Error("Current model profile does not configure reasoning effort.");
    }
    return reasoningEffort.set(effort);
  }

  resetReasoningEffort(): ReasoningEffortSnapshot {
    if (this.state !== "ready" || this.activeTurn !== undefined) {
      throw new Error(
        `Cannot change reasoning effort while RuntimeSession is ${this.state}.`,
      );
    }
    const reasoningEffort = this.input.modelClient.reasoningEffort;
    if (reasoningEffort === undefined) {
      throw new Error("Current model profile does not configure reasoning effort.");
    }
    return reasoningEffort.reset();
  }

  async importImage(
    sourcePath: string,
    signal: AbortSignal,
    prospectiveMessageImageCount: number,
  ): Promise<ImportedImageAsset> {
    if (this.state !== "ready") {
      throw new Error(`Cannot import an image while RuntimeSession is ${this.state}.`);
    }
    if (
      !Number.isSafeInteger(prospectiveMessageImageCount) ||
      prospectiveMessageImageCount < 1 ||
      prospectiveMessageImageCount > IMAGE_INPUT_POLICY.maxImagesPerMessage
    ) {
      throw new Error("Prospective Prompt image count is invalid.");
    }
    const assertImageAllowed = () => {
      if (this.state !== "ready") {
        throw new Error(
          `Cannot import an image while RuntimeSession is ${this.state}.`,
        );
      }
      if (!this.supportsImageInput()) {
        throw new Error("Current model profile does not support image input.");
      }
      const activeImageCount = this.input.modelClient.prepare(
        this.requireLedger().buildCommittedModelRequest(
          this.requireTooling().registry.definitions(),
        ).request,
      ).mediaOccurrenceCount;
      const aggregateImageCount = activeImageCount + prospectiveMessageImageCount;
      if (aggregateImageCount > IMAGE_INPUT_POLICY.maxImagesPerRequest) {
        throw new ModelRequestMediaAggregateError(
          `Model request would have ${aggregateImageCount} images; maximum is ${IMAGE_INPUT_POLICY.maxImagesPerRequest}.`,
        );
      }
    };

    if (this.supportsImageInput()) {
      assertImageAllowed();
    }
    return this.assetStore.importWorkspaceFile(sourcePath, {
      signal,
      accept: assertImageAllowed,
    });
  }

  async verifyImageAssets(
    assets: readonly ImageAssetRef[],
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.supportsImageInput()) {
      throw new Error("Current model profile does not support image input.");
    }
    for (const asset of assets) {
      signal.throwIfAborted();
      await this.assetStore.readVerified(asset, { signal });
    }
  }

  private requireContextAutomation(): ContextAutomationPolicy {
    if (this.contextAutomationPolicy === undefined) {
      throw new Error("RuntimeSession context automation is not initialized.");
    }
    return this.contextAutomationPolicy;
  }

  private requireActiveContextTool(
    call: ToolCall,
    expectedName: "ContextStatus" | "ContextSwapCandidates" | "ContextSwap",
  ): ActiveTurn & { consumedThroughOrdinal: number } {
    this.requireToolCall(call);
    const active = this.activeTurn;
    if (
      call.name !== expectedName ||
      active === undefined ||
      active.turn.turnId !== call.turnId ||
      active.consumedThroughOrdinal === undefined ||
      this.state !== "executing"
    ) {
      throw new ToolExecutionFatalError(
        `${expectedName} was called outside an active model iteration.`,
      );
    }
    return active as ActiveTurn & { consumedThroughOrdinal: number };
  }

  private prepareModelDispatch(input: {
    iteration: IterationIdentity;
    built: BuiltContextRequest;
  }): void {
    const active = this.activeTurn;
    if (
      active === undefined ||
      active.turn.turnId !== input.iteration.turnId ||
      active.turn.sessionId !== input.iteration.sessionId
    ) {
      throw new Error("Model dispatch does not belong to the active runtime turn.");
    }
    active.consumedThroughOrdinal = input.built.canonical.messages.length;
    this.runtimeSkills.markModelDispatch(input);
  }

  promptScheduler(): PromptSchedulerSnapshot {
    return this.scheduler.promptScheduler();
  }

  subscribePromptScheduler(listener: () => void): () => void {
    return this.scheduler.subscribePromptScheduler(listener);
  }

  queueFollowUp(userMessage: UserMessage): QueueFollowUpResult {
    return this.scheduler.queueFollowUp(userMessage);
  }

  admitTurn(input: ExecuteTurnInput): Promise<AcceptedTurn> {
    return this.scheduler.admitTurn(input);
  }

  async executeTurn(input: ExecuteTurnInput): Promise<RunAgentResult> {
    return (await this.admitTurn(input)).completion;
  }

  private async admitSingleTurn(input: ExecuteTurnInput): Promise<AcceptedTurn> {
    if (this.state !== "ready") {
      throw new Error(`Cannot execute a turn while RuntimeSession is ${this.state}.`);
    }
    validateUserMessage(input.userMessage);
    if (this.activeTurn !== undefined) {
      throw new Error("Cannot execute concurrent turns in one RuntimeSession.");
    }

    this.state = "admitting";
    const controller = new AbortController();
    const removeExternalAbortListener = forwardExternalAbort(input.signal, controller);
    const admission = createActiveAdmission(controller);
    this.activeAdmission = admission;
    let pendingLedgerTurn: ReturnType<SessionLedger["beginTurn"]>;
    let admissionPrepared: MaterializedModelRequest;
    let admissionSnapshot;
    try {
      controller.signal.throwIfAborted();
      const built = this.requireLedger().buildCandidateModelRequest(
        input.userMessage,
        this.requireTooling().registry.definitions(),
      );
      const admissionBase = this.createAdmissionBaseToken(built);
      const prepared = this.input.modelClient.prepare(built.request);
      const localSnapshot = this.contextMeter.measure(prepared);
      this.contextMeter.assertWithinBudget(localSnapshot);
      admissionPrepared = await materializeModelRequest(
        this.input.modelClient,
        prepared,
        { assetStore: this.assetStore, signal: controller.signal },
      );
      admissionSnapshot = this.contextMeter.measure(admissionPrepared);
      this.contextMeter.assertWithinBudget(admissionSnapshot);
      controller.signal.throwIfAborted();
      const turn = this.stageTurn(input.userMessage);
      pendingLedgerTurn = this.requireLedger().beginTurn({
        turn,
        userMessage: input.userMessage,
        admissionBase,
      });

      this.settleAdmission(admission);
      this.state = "executing";
      const completion = this.startAcceptedTurn({
        userMessage: input.userMessage,
        turn,
        pendingLedgerTurn,
        controller,
        removeExternalAbortListener,
        initialRequest: {
          prepared: admissionPrepared,
          usage: admissionSnapshot,
        },
      });
      this.activeTurn = {
        turn,
        ledger: pendingLedgerTurn.agent,
        controller,
        completion,
      };
      this.scheduler.notifyPromptScheduler();
      return Object.freeze({
        turnId: turn.turnId,
        userMessage: input.userMessage,
        completion,
      });
    } catch (error) {
      this.settleAdmission(admission);
      removeExternalAbortListener();
      if (error instanceof AdmissionStaleError) {
        this.nextTurnNumber = this.store.nextTurnNumber();
      }
      if (this.state === "admitting") {
        this.state = "ready";
      }
      if (isCanonicalRuntimeFault(error)) {
        this.fault(error);
      }
      throw error;
    }
  }

  private settleAdmission(admission: ActiveAdmission): void {
    if (this.activeAdmission !== admission) {
      throw new Error("Runtime admission ownership was lost.");
    }
    this.activeAdmission = undefined;
    admission.settle();
  }

  private createAdmissionBaseToken(built: BuiltContextRequest): AdmissionBaseToken {
    const meta = this.store.readMeta();
    const head = built.canonical.messages.at(-1);
    if (
      head === undefined ||
      meta.sessionCompatibilitySha256 === null ||
      built.revision.revisionId !== meta.activeRevisionId ||
      built.surface.surfaceSha256 !== built.revision.surfaceSha256 ||
      meta.nextTurnNumber !== this.nextTurnNumber
    ) {
      throw new Error("Cannot capture a consistent turn admission base.");
    }
    return Object.freeze({
      canonicalMessageCount: built.canonical.messages.length,
      canonicalHeadMessageId: head.messageId,
      canonicalHeadContentSha256: head.contentSha256,
      activeRevisionId: built.revision.revisionId,
      activeRevisionNumber: built.revision.revisionNumber,
      surfaceSha256: built.surface.surfaceSha256,
      sessionCompatibilitySha256: meta.sessionCompatibilitySha256,
      nextTurnNumber: meta.nextTurnNumber,
    });
  }

  compactContext(): Promise<ContextCompactionResult> {
    if (this.state !== "ready") {
      throw new Error(`Cannot compact context while RuntimeSession is ${this.state}.`);
    }
    if (this.activeTurn !== undefined) {
      throw new Error("Cannot compact context while a turn is active.");
    }
    const completion = this.contextMaintenance.performCompactContext();
    this.activeContextRevision = completion;
    void completion.then(
      () => {
        if (this.activeContextRevision === completion) {
          this.activeContextRevision = undefined;
        }
      },
      () => {
        if (this.activeContextRevision === completion) {
          this.activeContextRevision = undefined;
        }
      },
    );
    return completion;
  }

  retireContext(): Promise<ContextRetirementResult> {
    if (this.state !== "ready") {
      throw new Error(
        `Cannot retire context prefix while RuntimeSession is ${this.state}.`,
      );
    }
    if (this.activeTurn !== undefined) {
      throw new Error("Cannot retire context prefix while a turn is active.");
    }
    const completion = this.contextMaintenance.performRetireContext();
    this.activeContextRevision = completion;
    void completion.then(
      () => {
        if (this.activeContextRevision === completion) {
          this.activeContextRevision = undefined;
        }
      },
      () => {
        if (this.activeContextRevision === completion) {
          this.activeContextRevision = undefined;
        }
      },
    );
    return completion;
  }

  dispose(reason: SessionDisposeReason): Promise<void> {
    this.disposePromise ??= this.performDispose(reason);
    return this.disposePromise;
  }

  canSwitchSession(): boolean {
    return (
      this.state === "ready" &&
      !this.scheduler.isRunning &&
      this.scheduler.pendingCount === 0 &&
      this.activeTurn === undefined &&
      (this.tooling?.taskManager
        .listBackgroundTasks()
        .every((task) => task.status !== "running" && task.status !== "stopping") ??
        true)
    );
  }

  async undoLatestFileMutationTurn(): Promise<TurnUndoResult> {
    if (
      this.state !== "ready" ||
      this.activeTurn !== undefined ||
      this.activeContextRevision !== undefined
    ) {
      throw new Error("Cannot undo while a turn or context operation is active.");
    }
    const tooling = this.requireTooling();
    if (
      tooling.taskManager
        .listBackgroundTasks()
        .some((task) => task.status === "running" || task.status === "stopping")
    ) {
      throw new Error("Cannot undo while a background task is active.");
    }
    if (tooling.turnUndoManager === undefined) {
      return { status: "nothing" };
    }

    this.state = "undoing";
    try {
      return await tooling.turnUndoManager.undoLatest();
    } finally {
      if (this.state === "undoing") {
        this.state = "ready";
      }
    }
  }

  async cloneSession(targetSessionId: SessionId): Promise<void> {
    if (!this.canSwitchSession()) {
      throw new Error(
        "Cannot clone the session while a turn, context operation, or background task is active.",
      );
    }
    await this.waitForStableEventTail();
    if (!this.canSwitchSession()) {
      throw new Error(
        "Cannot clone the session while a turn, context operation, or background task is active.",
      );
    }
    await this.store.cloneTo({ targetSessionId });
  }

  private async waitForStableEventTail(): Promise<void> {
    for (;;) {
      const tail = this.eventTail;
      await tail;
      if (this.eventTail === tail) {
        return;
      }
    }
  }

  private async startAcceptedTurn(input: {
    userMessage: UserMessage;
    turn: TurnIdentity;
    pendingLedgerTurn: ReturnType<SessionLedger["beginTurn"]>;
    controller: AbortController;
    removeExternalAbortListener: () => void;
    initialRequest: NonNullable<RunAgentInput["initialRequest"]>;
  }): Promise<RunAgentResult> {
    try {
      this.registerTurn(input.turn);
    } catch (error) {
      input.removeExternalAbortListener();
      input.pendingLedgerTurn.fault(error);
      this.activeTurn = undefined;
      this.fault(error);
      throw error;
    }
    return this.performExecuteTurn(
      input.userMessage,
      input.turn,
      input.pendingLedgerTurn,
      input.controller.signal,
      input.removeExternalAbortListener,
      input.initialRequest,
    );
  }

  private async performExecuteTurn(
    userMessage: UserMessage,
    turn: TurnIdentity,
    pendingLedgerTurn: ReturnType<SessionLedger["beginTurn"]>,
    signal: AbortSignal,
    removeExternalAbortListener: () => void,
    initialRequest: NonNullable<RunAgentInput["initialRequest"]>,
  ): Promise<RunAgentResult> {
    let settled = false;

    try {
      await this.append({
        type: "turn.started",
        ...turn,
        data: { userPrompt: projectUserMessage(userMessage) },
      });

      let result: RunAgentResult;
      try {
        result = await runAgent({
          ledger: pendingLedgerTurn.agent,
          maxIterations: this.input.maxIterations,
          model: this.input.modelClient,
          contextMeter: this.contextMeter,
          committedPrefixAuditor: this.committedPrefixAuditor,
          shadowPlanning: {
            planner: this.shadowPlanner,
            select: (planningInput) => {
              const selection = this.dependencies.selectShadowPlanning(planningInput);
              if (
                selection?.trigger === "runtime_pressure" &&
                this.requireContextAutomation().automaticSwap
              ) {
                this.contextMaintenance.scheduleAutomaticMaintenance();
              }
              return selection;
            },
            ...(this.dependencies.onShadowPlanningResult === undefined
              ? {}
              : { onResult: this.dependencies.onShadowPlanningResult }),
          },
          tools: this.requireTooling().registry,
          toolRuntime: this.requireTooling().runtime,
          observationBuilder: this.observationBuilder,
          runtimeSession: this.context,
          turn,
          signal,
          assetStore: this.assetStore,
          initialRequest,
        });
      } catch (error) {
        if (error instanceof RuntimeEventAppendError) {
          throw error;
        }

        if (error instanceof FatalAgentTurnError) {
          await this.appendTerminalEvent(
            turn,
            error.result,
            pendingLedgerTurn.projectedMessageCount(),
          );
          pendingLedgerTurn.finish(error.result);
          settled = true;
          await this.runtimeSkills.settleClosedTurnSkills();
          throw error;
        }

        await this.append({
          type: "turn.failed",
          ...turn,
          data: { error: errorMessage(error) },
        });
        throw error;
      }

      const projectedMessageCount = pendingLedgerTurn.projectedMessageCount();
      await this.appendTerminalEvent(turn, result, projectedMessageCount);
      pendingLedgerTurn.finish(result);
      settled = true;
      this.requireTooling().turnUndoManager?.completeTurn(turn);
      if (result.status === "completed") {
        this.notifyCompletedTurn(turn);
      }
      await this.runtimeSkills.settleClosedTurnSkills();
      if (result.status === "completed") {
        await this.contextMaintenance.evaluateClosedTurnContextPressure();
        await this.contextMaintenance.performAutomaticContextMaintenance();
      }
      return result;
    } catch (error) {
      if (!settled) {
        pendingLedgerTurn.fault(error);
      }
      this.fault(error);
      throw error;
    } finally {
      removeExternalAbortListener();
      this.activeTurn = undefined;
      this.scheduler.notifyPromptScheduler();
      this.contextMaintenance.finishTurn();
      if (this.state === "executing") {
        this.state = "ready";
      }
    }
  }

  private notifyCompletedTurn(turn: TurnIdentity): void {
    const hook = this.input.completedTurnHook;
    if (hook === undefined) {
      return;
    }
    let snapshot: CompletedTurnSnapshot;
    try {
      snapshot = this.store.readCompletedTurnSnapshot(turn.turnId);
    } catch {
      this.recordCompletedTurnHookFailure(
        hook,
        turn.turnId,
        "completed_turn_snapshot_failed",
      );
      return;
    }
    try {
      hook.enqueue({
        workspaceRoot: this.input.workspaceRoot,
        sessionId: this.sessionId,
        turnId: turn.turnId,
        snapshot,
      });
    } catch {
      this.recordCompletedTurnHookFailure(
        hook,
        turn.turnId,
        "completed_turn_enqueue_failed",
      );
    }
  }

  private recordCompletedTurnHookFailure(
    hook: CompletedTurnHook,
    turnId: TurnId,
    reason: CompletedTurnHookFailure["reason"],
  ): void {
    try {
      hook.recordFailure({
        workspaceRoot: this.input.workspaceRoot,
        sessionId: this.sessionId,
        turnId,
        reason,
      });
    } catch {
      // Optional completed-turn integrations never fault a committed turn.
    }
  }

  private async appendTerminalEvent(
    turn: TurnIdentity,
    result: RunAgentResult,
    projectedMessageCount: number,
  ): Promise<void> {
    if (result.status === "completed") {
      await this.append({
        type: "turn.finished",
        ...turn,
        data: {
          status: result.status,
          finalText: result.finalText,
          lastIteration: result.lastIteration,
          messageCount: projectedMessageCount,
        },
      });
      return;
    }

    if (result.status === "cancelled") {
      await this.append({
        type: "turn.cancelled",
        ...result.lastIteration,
        data: { cancellation: result.cancellation },
      });
      return;
    }

    await this.append({
      type: "turn.failed",
      ...result.lastIteration,
      data: { error: result.error },
    });
  }

  private async performDispose(reason: SessionDisposeReason): Promise<void> {
    if (this.state === "disposed") {
      return;
    }

    this.state = "disposing";
    this.scheduler.clear();
    const errors: unknown[] = this.faultCause === undefined ? [] : [this.faultCause];
    const activeAdmission = this.activeAdmission;
    if (activeAdmission !== undefined) {
      activeAdmission.controller.abort(new TurnCancelledError("session_dispose"));
      await activeAdmission.settled;
    }
    const activeContextRevision = this.activeContextRevision;
    if (activeContextRevision !== undefined) {
      try {
        await activeContextRevision;
      } catch {
        // The compactContext caller owns its primary error. Disposal still continues.
      }
    }
    if (this.faultCause !== undefined && !errors.includes(this.faultCause)) {
      errors.push(this.faultCause);
    }
    const activeTurn = this.activeTurn;
    if (activeTurn !== undefined) {
      activeTurn.controller.abort(new TurnCancelledError("session_dispose"));
      try {
        await activeTurn.completion;
      } catch {
        // The executeTurn caller owns its primary error. Disposal still continues.
      }
    }

    if (this.mcpManager !== undefined) {
      await collectError(errors, () => this.mcpManager!.dispose());
    }
    if (this.tooling !== undefined) {
      await collectError(errors, () => this.tooling!.dispose(reason.type));
    }
    await collectError(errors, () =>
      this.append({
        type: "session.finished",
        sessionId: this.sessionId,
        data: {
          reason: reason.type,
          ...("error" in reason ? { error: reason.error } : {}),
        },
      }),
    );
    await collectError(errors, () => this.store.close(reason.type));

    this.state = "disposed";
    throwCollectedErrors(errors, "RuntimeSession disposal failed.");
  }

  private async rollbackInitialization(
    initializationError: unknown,
    started: boolean,
  ): Promise<never> {
    this.state = "disposing";
    const errors: unknown[] = [initializationError];

    if (this.mcpManager !== undefined) {
      await collectError(errors, () => this.mcpManager!.dispose());
    }
    if (this.tooling !== undefined) {
      await collectError(errors, () => this.tooling!.dispose("initialization_failed"));
    }
    if (started) {
      await collectError(errors, () =>
        this.append({
          type: "session.finished",
          sessionId: this.sessionId,
          data: {
            reason: "initialization_failed",
            error: errorMessage(initializationError),
          },
        }),
      );
    }
    await collectError(errors, async () => {
      let meta;
      try {
        meta = this.store.readMeta();
      } catch (error) {
        await this.store.abandon().catch(() => undefined);
        throw error;
      }
      if (
        this.input.selection.mode === "new" &&
        meta.initializationState === "creating" &&
        meta.nextTurnNumber === 1
      ) {
        await this.store.deleteFromDisk();
        return;
      }
      await this.store.close("initialization_failed");
    });

    this.state = "disposed";
    throwCollectedErrors(errors, "RuntimeSession initialization failed.");
    throw new Error("Initialization error collection unexpectedly returned.");
  }

  private stageTurn(userMessage: UserMessage): TurnIdentity {
    validateUserMessage(userMessage);

    const identity: TurnIdentity = {
      sessionId: this.sessionId,
      turnId: this.dependencies.idFactory.createTurnId(),
      turnNumber: this.nextTurnNumber,
    };
    return identity;
  }

  private registerTurn(identity: TurnIdentity): void {
    if (identity.turnNumber !== this.nextTurnNumber) {
      throw new Error(
        `turnNumber must be ${this.nextTurnNumber}; received ${identity.turnNumber}.`,
      );
    }
    this.nextTurnNumber += 1;
    this.turns.set(identity.turnId, identity);
    this.nextIterationNumberByTurn.set(identity.turnId, 1);
  }

  private createIteration(
    turn: TurnIdentity,
    iterationNumber: number,
  ): IterationIdentity {
    this.requireTurn(turn);
    requirePositiveNumber(iterationNumber, "iterationNumber");
    const expected = this.nextIterationNumberByTurn.get(turn.turnId);
    if (iterationNumber !== expected) {
      throw new Error(
        `iterationNumber for turn ${turn.turnId} must be ${expected}; received ${iterationNumber}.`,
      );
    }

    const identity: IterationIdentity = {
      ...turn,
      iterationId: this.dependencies.idFactory.createIterationId(),
      iterationNumber,
    };
    this.store.beginIteration(identity);
    this.iterations.set(identity.iterationId, identity);
    this.nextIterationNumberByTurn.set(turn.turnId, iterationNumber + 1);
    this.nextToolCallNumberByIteration.set(identity.iterationId, 1);
    return identity;
  }

  private updateAssistantTextDelta(update: AssistantTextDeltaUpdate): void {
    const sink = this.input.assistantTextDeltaSink;
    const iteration = this.iterations.get(update.iterationId);
    if (
      sink === undefined ||
      this.assistantTextDeltaSinkDisabled ||
      this.state !== "executing" ||
      update.content === "" ||
      !Number.isSafeInteger(update.attemptNumber) ||
      update.attemptNumber < 1 ||
      iteration === undefined ||
      iteration.sessionId !== update.sessionId ||
      iteration.turnId !== update.turnId ||
      iteration.turnNumber !== update.turnNumber ||
      iteration.iterationNumber !== update.iterationNumber
    ) {
      return;
    }

    try {
      sink.updateAssistantTextDelta(update);
    } catch {
      this.assistantTextDeltaSinkDisabled = true;
    }
  }

  private createToolCall(
    iteration: IterationIdentity,
    toolCallNumber: number,
  ): ToolCallIdentity {
    this.requireIteration(iteration);
    requirePositiveNumber(toolCallNumber, "toolCallNumber");
    const expected = this.nextToolCallNumberByIteration.get(iteration.iterationId);
    if (toolCallNumber !== expected) {
      throw new Error(
        `toolCallNumber for iteration ${iteration.iterationId} must be ${expected}; received ${toolCallNumber}.`,
      );
    }

    const identity: ToolCallIdentity = {
      ...iteration,
      toolCallId: this.dependencies.idFactory.createToolCallId(),
      toolCallNumber,
    };
    this.toolCalls.set(identity.toolCallId, identity);
    this.nextToolCallNumberByIteration.set(iteration.iterationId, toolCallNumber + 1);
    return identity;
  }

  private finishIterationForContinuation(iteration: IterationIdentity): void {
    this.requireIteration(iteration);
    this.store.finishIterationForContinuation(iteration);
  }

  private append(input: AgentEventInput): Promise<void> {
    if (this.state === "disposed") {
      throw new Error("Cannot append events after RuntimeSession is disposed.");
    }

    this.validateEventIdentity(input);
    let eventSequence: number;
    try {
      eventSequence = this.store.allocateEventSequence();
    } catch (error) {
      this.fault(error);
      throw error;
    }
    const event: AgentEvent = {
      ...input,
      eventSequence,
      timestamp: new Date().toISOString(),
    } as AgentEvent;

    const write = this.eventTail
      .then(async () => {
        const result = await this.eventSink.append(event);
        for (const diagnostic of result?.diagnostics ?? []) {
          void this.append({
            type: "diagnostic.sink_failed",
            sessionId: this.sessionId,
            data: diagnostic,
          }).catch(() => undefined);
        }
      })
      .catch((error) => {
        const appendError =
          error instanceof RuntimeEventAppendError
            ? error
            : new RuntimeEventAppendError(input.type, { cause: error });
        this.fault(appendError);
        throw appendError;
      });
    this.eventTail = write.catch(() => undefined);
    return write;
  }

  private validateEventIdentity(input: AgentEventInput): void {
    if (input.sessionId !== this.sessionId) {
      throw new Error(
        `Event ${input.type} belongs to session ${input.sessionId}, expected ${this.sessionId}.`,
      );
    }

    if ("toolCallId" in input) {
      this.requireToolCall(input);
      this.requireMatchingEventData(input);
      return;
    }
    if ("iterationId" in input) {
      this.requireIteration(input);
      return;
    }
    if ("turnId" in input) {
      this.requireTurn(input);
    }
  }

  private requireMatchingEventData(input: AgentEventInput): void {
    if (!("toolCallId" in input)) {
      return;
    }

    let relatedIdentity: ToolCallIdentity | undefined;
    switch (input.type) {
      case "tool.started":
      case "tool.raw_result":
      case "tool.finished":
      case "tool.observation":
        relatedIdentity = input.data.call;
        break;
      case "bash.task.backgrounded":
      case "bash.task.stopping":
      case "bash.task.finished":
        relatedIdentity = input.data.task.origin;
        break;
      default:
        return;
    }
    if (
      relatedIdentity !== undefined &&
      relatedIdentity.toolCallId !== input.toolCallId
    ) {
      throw new Error(
        `Event ${input.type} data belongs to tool call ${relatedIdentity.toolCallId}, expected ${input.toolCallId}.`,
      );
    }
  }

  private requireTurn(turn: TurnIdentity): void {
    const registered = this.turns.get(turn.turnId);
    if (
      registered === undefined ||
      registered.sessionId !== turn.sessionId ||
      registered.turnNumber !== turn.turnNumber
    ) {
      throw new Error(`Unknown or mismatched turn identity: ${turn.turnId}.`);
    }
  }

  private requireIteration(iteration: IterationIdentity): void {
    this.requireTurn(iteration);
    const registered = this.iterations.get(iteration.iterationId);
    if (
      registered === undefined ||
      registered.turnId !== iteration.turnId ||
      registered.iterationNumber !== iteration.iterationNumber
    ) {
      throw new Error(
        `Unknown or mismatched iteration identity: ${iteration.iterationId}.`,
      );
    }
  }

  private requireToolCall(toolCall: ToolCallIdentity): void {
    this.requireIteration(toolCall);
    const registered = this.toolCalls.get(toolCall.toolCallId);
    if (
      registered === undefined ||
      registered.iterationId !== toolCall.iterationId ||
      registered.toolCallNumber !== toolCall.toolCallNumber
    ) {
      throw new Error(
        `Unknown or mismatched tool call identity: ${toolCall.toolCallId}.`,
      );
    }
  }

  private requireTooling(): DefaultTooling {
    if (this.tooling === undefined) {
      throw new Error("RuntimeSession tooling is not initialized.");
    }
    return this.tooling;
  }

  private requireLedger(): SessionLedger {
    if (this.ledger === undefined) {
      throw new Error("RuntimeSession ledger is not initialized.");
    }
    return this.ledger;
  }

  private requireContextManager(): ContextManager {
    if (this.contextManager === undefined) {
      throw new Error("RuntimeSession ContextManager is not initialized.");
    }
    return this.contextManager;
  }

  private fault(error: unknown): void {
    this.faultCause ??= error;
    if (this.state !== "disposing" && this.state !== "disposed") {
      this.state = "faulted";
    }
  }
}

export async function createRuntimeSession(
  input: CreateRuntimeSessionInput,
  dependencyOverrides: Partial<RuntimeSessionFactoryDependencies> = {},
): Promise<RuntimeSession> {
  return DefaultRuntimeSession.create(input, {
    ...defaultDependencies,
    ...dependencyOverrides,
  });
}

function createEventSink(
  input: CreateRuntimeSessionInput,
  sessionDirectory: string,
): EventSink {
  const requiredSinks: EventSink[] = [];
  if (input.persistence !== false) {
    requiredSinks.push(
      new JsonlEventLog(
        input.persistence?.eventLogPath ?? path.join(sessionDirectory, "events.jsonl"),
      ),
      new ObservationTextLog(
        input.persistence?.observationLogPath ??
          path.join(sessionDirectory, "observations.md"),
      ),
    );
  }
  return new CompositeEventSink({
    requiredSinks,
    auxiliarySinks: input.presentationSinks ?? [],
  });
}

function validateCreateInput(input: CreateRuntimeSessionInput): void {
  if (input.selection.sessionId.trim() === "") {
    throw new Error("RuntimeSession sessionId must not be empty.");
  }
  if (!path.isAbsolute(input.workspaceRoot)) {
    throw new Error("RuntimeSession workspaceRoot must be an absolute path.");
  }
  if (
    input.skillCatalog !== undefined &&
    input.skillCatalog.workspaceRoot !== input.workspaceRoot
  ) {
    throw new Error("RuntimeSession Agent Skill catalog belongs to another workspace.");
  }
  if (input.modelName.trim() === "") {
    throw new Error("RuntimeSession modelName must not be empty.");
  }

  requirePositiveNumber(input.maxIterations, "maxIterations");
  if (input.systemPrompt.trim() === "") {
    throw new Error("RuntimeSession systemPrompt must not be empty.");
  }
  if (
    typeof input.modelClient !== "object" ||
    input.modelClient === null ||
    typeof input.modelClient.prepare !== "function" ||
    typeof input.modelClient.request !== "function" ||
    typeof input.modelClient.messageProtocol !== "object" ||
    input.modelClient.messageProtocol === null
  ) {
    throw new Error(
      "RuntimeSession modelClient must implement prepare() and request().",
    );
  }

  assertMatchingContextBudget(input.contextProfile, input.contextBudget);
}

function isNewSessionInput(
  input: CreateRuntimeSessionInput,
): input is CreateNewRuntimeSessionInput {
  return input.selection.mode === "new";
}

function createActiveAdmission(controller: AbortController): ActiveAdmission {
  let resolve!: () => void;
  const settled = new Promise<void>((settle) => {
    resolve = settle;
  });
  let didSettle = false;
  return {
    controller,
    settled,
    settle: () => {
      if (!didSettle) {
        didSettle = true;
        resolve();
      }
    },
  };
}

function forwardExternalAbort(
  externalSignal: AbortSignal,
  internalController: AbortController,
): () => void {
  const forward = () => {
    internalController.abort(
      new TurnCancelledError("user", undefined, {
        cause: externalSignal.reason,
      }),
    );
  };

  if (externalSignal.aborted) {
    forward();
    return () => undefined;
  }

  externalSignal.addEventListener("abort", forward, { once: true });
  return () => externalSignal.removeEventListener("abort", forward);
}

async function collectError(
  errors: unknown[],
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!errors.includes(error)) {
      errors.push(error);
    }
  }
}

function throwCollectedErrors(errors: unknown[], message: string): void {
  if (errors.length === 0) {
    return;
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  throw new AggregateError(errors, message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requirePositiveNumber(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer; received ${value}.`);
  }
}

function isCanonicalRuntimeFault(error: unknown): boolean {
  return (
    error instanceof ContextProtocolError ||
    error instanceof ContextRevisionError ||
    error instanceof CompiledContextError ||
    error instanceof SessionLedgerWriteError ||
    error instanceof SessionError
  );
}
