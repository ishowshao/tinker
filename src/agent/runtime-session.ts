import path from "node:path";
import { CompositeEventSink } from "../events/composite-event-sink";
import type { EventSink } from "../events/event-sink";
import { JsonlEventLog } from "../events/jsonl-event-log";
import { ObservationTextLog } from "../events/observation-text-log";
import type {
  AgentEvent,
  AgentEventInput,
  AgentEventType,
  ContextRevisionFinishedData,
} from "../events/types";
import {
  runtimeIdFactory,
  type RuntimeIdFactory,
  type SessionId,
} from "../ids/runtime-id";
import { loadMcpConfig } from "../mcp/mcp-config";
import { createMcpManager, type McpManager } from "../mcp/mcp-manager";
import type { ModelClient } from "../model/model-client";
import { CommittedPrefixAuditor } from "../model/committed-prefix-auditor";
import { SwapPlanner } from "../context/swap-planner";
import {
  commitAgentSkillsContextUpdate,
  ContextManager,
  ContextManagerError,
  type ContextCompactionResult,
  type ContextCompactionTrigger,
  type ContextRetirementResult,
  type ContextRetirementTrigger,
} from "../context/context-manager";
import {
  assertMatchingContextBudget,
  type ModelContextBudget,
  type ModelContextProfile,
} from "../model/model-context-profile";
import { ObservationBuilder } from "../observation/observation-builder";
import { ContextProtocolError } from "../context/context-protocol-validator";
import { CompiledContextError } from "../context/compiled-context-validator";
import {
  ContextRevisionCompiler,
  ContextRevisionError,
} from "../context/context-revision-compiler";
import {
  changedContextSurfaceComponents,
  contextSurfaceChangeManifestHash,
  contextSurfaceChanges,
  createContextSurface,
  sameContextSurface,
  type ContextSurfaceComponent,
  type StoredContextSurfaceV8,
} from "../context/context-surface";
import {
  canonicalSequenceHash,
  renderedMessageHash,
} from "../context/compiled-context-hash";
import { createDefaultTooling, type DefaultTooling } from "../tools/registry";
import type { Refiner } from "../tools/web-fetch/refiner";
import type { ProjectInstructionManifest } from "../instructions/project-instructions";
import {
  SessionStore,
  createSessionCompatibilityContract,
  type SessionRecoveryResult,
  type StoredSkillActivation,
} from "../session/session-store";
import { SqliteSessionLedger } from "../session/sqlite-session-ledger";
import { SessionError } from "../session/session-errors";
import { FatalAgentTurnError, runAgent, type RunAgentInput } from "./loop";
import { SessionLedgerWriteError, type SessionLedger } from "./session-ledger";
import { TurnCancelledError } from "./turn-cancellation";
import type { ToolCompletionInput } from "../context/protocol-frame";
import type { BuiltContextRequest } from "../context/context-revision";
import type { CommittedToolCompletion } from "./session-ledger";
import type {
  IterationIdentity,
  RunAgentResult,
  ToolCallIdentity,
  TurnIdentity,
} from "./types";
import { ContextMeter } from "./context-meter";
import { CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION } from "../context/recall-retirement-contract";
import {
  selectContextAutomation,
  type ContextAutomationDecision,
} from "../context/context-automation-policy";
import type { SkillCatalogSnapshot } from "../skills/skill-loader";
import {
  activeSkillManifestEntry,
  createSkillCatalogSnapshot,
  skillCatalogManifest,
} from "../skills/skill-catalog";
import {
  buildActiveSystemPrompt,
  rebindActiveSkills,
  renderSkillActivationReceipt,
  SkillActivationCoordinator,
} from "../skills/skill-context";

export type ExecuteTurnInput = {
  userPrompt: string;
  signal: AbortSignal;
};

export type SessionDisposeReason =
  | { type: "oneshot_complete" }
  | { type: "tui_exit" }
  | { type: "session_switch" }
  | { type: "runner_failed"; error: string }
  | { type: "initialization_failed"; error: string };

export type RuntimeSession = {
  readonly sessionId: SessionId;
  readonly resumed: boolean;
  readonly recovery: SessionRecoveryResult;
  skills(): RuntimeSkillsSnapshot;
  executeTurn(input: ExecuteTurnInput): Promise<RunAgentResult>;
  compactContext(): Promise<ContextCompactionResult>;
  retireContext(): Promise<ContextRetirementResult>;
  canSwitchSession(): boolean;
  dispose(reason: SessionDisposeReason): Promise<void>;
};

export type RuntimeSkillsSnapshot = {
  readonly skills: readonly {
    readonly name: string;
    readonly description: string;
    readonly scope: "project" | "user";
    readonly active: boolean;
  }[];
  readonly shadowedNames: readonly string[];
};

export type RuntimeSessionContext = {
  readonly sessionId: SessionId;
  createIteration(turn: TurnIdentity, iterationNumber: number): IterationIdentity;
  createToolCall(
    iteration: IterationIdentity,
    toolCallNumber: number,
  ): ToolCallIdentity;
  finishIterationForContinuation(iteration: IterationIdentity): void;
  append(input: AgentEventInput): Promise<void>;
  onToolCompletionsCommitted?(input: {
    completions: readonly ToolCompletionInput[];
    committed: readonly CommittedToolCompletion[];
  }): void;
  prepareModelDispatch?(input: {
    iteration: IterationIdentity;
    built: BuiltContextRequest;
  }): void;
};

export type ContextSurfaceRefreshSummary = {
  readonly previousRevisionNumber: number;
  readonly revisionNumber: number;
  readonly changed: readonly ContextSurfaceComponent[];
  readonly toolCountBefore: number;
  readonly toolCountAfter: number;
};

export type SkillsUpdateSummary = {
  readonly previousRevisionNumber: number;
  readonly revisionNumber: number;
  readonly activated: readonly string[];
  readonly refreshed: readonly string[];
  readonly deactivated: readonly string[];
  readonly unavailable: readonly string[];
  readonly addedOverrideCount: number;
};

type CommonRuntimeSessionInput = {
  workspaceRoot: string;
  modelName: string;
  profileName?: string;
  maxIterations: number;
  includeReasoningContent: boolean;
  contextProfile: ModelContextProfile;
  contextBudget: ModelContextBudget;
  modelClient: ModelClient;
  systemPrompt: string;
  projectInstruction?: ProjectInstructionManifest;
  skillCatalog?: SkillCatalogSnapshot;
  presentationSinks?: EventSink[];
  persistence?:
    | false
    | {
        eventLogPath?: string;
        observationLogPath?: string;
      };
  webFetchRefiner?: Refiner;
};

type CreateNewRuntimeSessionInput = CommonRuntimeSessionInput & {
  selection: { mode: "new"; sessionId: SessionId };
};

type ResumeRuntimeSessionInput = CommonRuntimeSessionInput & {
  selection: { mode: "resume"; sessionId: SessionId };
};

export type CreateRuntimeSessionInput =
  | CreateNewRuntimeSessionInput
  | ResumeRuntimeSessionInput;

export type RuntimeSessionFactoryDependencies = {
  idFactory: RuntimeIdFactory;
  createTooling: typeof createDefaultTooling;
  loadMcpConfig: typeof loadMcpConfig;
  createMcpManager: typeof createMcpManager;
  createObservationBuilder: () => ObservationBuilder;
  openStore: (
    input: CreateRuntimeSessionInput,
    idFactory: RuntimeIdFactory,
  ) => Promise<SessionStore>;
  createLedger: (store: SessionStore, idFactory: RuntimeIdFactory) => SessionLedger;
  createEventSink: (input: CreateRuntimeSessionInput) => EventSink;
  selectShadowPlanning: NonNullable<RunAgentInput["shadowPlanning"]>["select"];
  onShadowPlanningResult?: NonNullable<RunAgentInput["shadowPlanning"]>["onResult"];
  selectContextAutomation: typeof selectContextAutomation;
  automaticCompactionTrigger: () => ContextCompactionTrigger;
  automaticRetirementTrigger: () => ContextRetirementTrigger;
  manualCompactionTrigger: () => ContextCompactionTrigger;
  manualRetirementTrigger: () => ContextRetirementTrigger;
};

export class RuntimeEventAppendError extends Error {
  readonly eventType: AgentEventType;

  constructor(eventType: AgentEventType, options?: ErrorOptions) {
    super(`Failed to append runtime event ${eventType}.`, options);
    this.name = "RuntimeEventAppendError";
    this.eventType = eventType;
  }
}

type RuntimeSessionState =
  | "initializing"
  | "ready"
  | "executing"
  | "compacting"
  | "maintaining_context"
  | "faulted"
  | "disposing"
  | "disposed";

type ActiveTurn = {
  controller: AbortController;
  completion: Promise<RunAgentResult>;
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
        })
      : SessionStore.openExisting({
          workspaceRoot: input.workspaceRoot,
          sessionId: input.selection.sessionId,
        }),
  createLedger: (store, idFactory) => new SqliteSessionLedger(store, idFactory),
  createEventSink,
  selectShadowPlanning: ({ preflight }) =>
    preflight.pressure === "normal" ? undefined : { trigger: "runtime_pressure" },
  selectContextAutomation,
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
  private contextAutomationDecision?: ContextAutomationDecision;
  private pendingAutomaticContextMaintenance = false;
  private readonly skillCatalog: SkillCatalogSnapshot;
  private skillCoordinator = new SkillActivationCoordinator();

  private readonly context: RuntimeSessionContext;

  private constructor(
    private readonly input: CreateRuntimeSessionInput,
    private readonly dependencies: RuntimeSessionFactoryDependencies,
    private readonly eventSink: EventSink,
    private readonly observationBuilder: ObservationBuilder,
    private readonly store: SessionStore,
  ) {
    this.sessionId = input.selection.sessionId;
    this.resumed = input.selection.mode === "resume";
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
    this.context = {
      sessionId: this.sessionId,
      createIteration: (turn, iterationNumber) =>
        this.createIteration(turn, iterationNumber),
      createToolCall: (iteration, toolCallNumber) =>
        this.createToolCall(iteration, toolCallNumber),
      finishIterationForContinuation: (iteration) =>
        this.finishIterationForContinuation(iteration),
      append: (event) => this.append(event),
      onToolCompletionsCommitted: (completion) =>
        this.onToolCompletionsCommitted(completion),
      prepareModelDispatch: (dispatch) => this.prepareModelDispatch(dispatch),
    };
  }

  static async create(
    input: CreateRuntimeSessionInput,
    dependencies: RuntimeSessionFactoryDependencies,
  ): Promise<RuntimeSession> {
    validateCreateInput(input);
    const store = await dependencies.openStore(input, dependencies.idFactory);
    let session: DefaultRuntimeSession;
    try {
      session = new DefaultRuntimeSession(
        input,
        dependencies,
        dependencies.createEventSink(input),
        dependencies.createObservationBuilder(),
        store,
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
        session.skillCoordinator = new SkillActivationCoordinator({
          active: rebound.active,
        });
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
        workspaceRoot: input.workspaceRoot,
        runtimeSession: session.context,
        historyReader: store.historyReader(),
        webFetchRefiner: input.webFetchRefiner,
        ...(session.skillCatalog.skills.size === 0
          ? {}
          : {
              skillCatalog: session.skillCatalog,
              skillCoordinator: session.skillCoordinator,
            }),
      });

      const mcpConfig = await dependencies.loadMcpConfig(input.workspaceRoot);
      if (mcpConfig !== undefined) {
        session.mcpManager = await dependencies.createMcpManager({
          config: mcpConfig,
          runtimeSession: session.context,
        });
        for (const executor of session.mcpManager.executors) {
          session.tooling.registry.register(executor, "MCP");
        }
      }

      const definitions = session.requireTooling().registry.definitions();
      const activeSystemPrompt = buildActiveSystemPrompt({
        baseSystemPrompt: input.systemPrompt,
        activeSkills: session.skillCoordinator.activeEntries(),
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
        activeSkills: session.skillCoordinator.activeManifest(),
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
            ? await session.refreshContextSurface(candidateSurface)
            : undefined;
        if (resumeSkills.unresolved.length > 0) {
          skillsUpdate = await session.commitSkillSettlements({
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

      await session.appendSkillsCatalogLoaded();

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

      session.contextAutomationDecision = dependencies.selectContextAutomation({
        ...(input.profileName === undefined ? {} : { profileName: input.profileName }),
        surface: store.loadContextSnapshot().surface,
      });
      if (
        input.selection.mode === "resume" &&
        initialSnapshot.pressure !== "normal" &&
        session.contextAutomationDecision.automaticSwapOnly
      ) {
        session.pendingAutomaticContextMaintenance = true;
        session.state = "executing";
        await session.performAutomaticContextMaintenance();
      }

      session.state = "ready";
      return session;
    } catch (error) {
      return session.rollbackInitialization(error, started);
    }
  }

  private async refreshContextSurface(
    candidateSurface: StoredContextSurfaceV8,
  ): Promise<ContextSurfaceRefreshSummary | undefined> {
    const snapshot = this.store.loadContextSnapshot();
    if (sameContextSurface(snapshot.surface, candidateSurface)) {
      return undefined;
    }

    const changes = contextSurfaceChanges(snapshot.surface, candidateSurface);
    const changed = changedContextSurfaceComponents(changes);
    if (changed.length === 0) {
      throw new Error("Changed context surface has an empty change manifest.");
    }
    const startedAt = performance.now();
    await this.append({
      type: "context.revision.started",
      sessionId: this.sessionId,
      data: {
        strategy: "surface_refresh",
        reason: "resume",
        baseRevisionNumber: snapshot.revision.revisionNumber,
        changed,
      },
    });

    let stage: "prepare" | "commit" | "activate" = "prepare";
    let committed = false;
    try {
      const compiler = new ContextRevisionCompiler();
      const active = compiler.compileActive(snapshot);
      const candidateCompiled = compiler.compileProspective({
        active,
        canonical: snapshot.canonical,
        activeOverrides: snapshot.activeOverrides,
        addedOverrides: [],
        activeSurface: snapshot.surface,
        surface: candidateSurface,
      });
      const prepared = this.input.modelClient.prepare({
        messages: candidateCompiled.entries.map((entry) => entry.message),
        tools: [...candidateSurface.toolDefinitions],
      });
      assertPreparedMatchesSurface(prepared, candidateSurface);

      stage = "commit";
      const revision = this.store.commitSurfaceRefresh({
        revisionId: this.dependencies.idFactory.createContextRevisionId(),
        expectedBaseRevisionId: snapshot.revision.revisionId,
        expectedBaseRevisionNumber: snapshot.revision.revisionNumber,
        expectedCanonicalThroughOrdinal: snapshot.canonical.messages.length,
        expectedBaseActiveOverrideManifestSha256:
          snapshot.revision.activeOverrideManifestSha256,
        surface: candidateSurface,
        changes,
        changeManifestSha256: contextSurfaceChangeManifestHash(changes),
        canonicalSequenceSha256: canonicalSequenceHash(snapshot.canonical),
        renderedMessageSha256: renderedMessageHash(candidateCompiled.entries),
      });
      committed = true;

      stage = "activate";
      this.contextMeter.startRevision({
        reason: "context_rebuilt",
        requestConfigHash: prepared.requestConfigHash,
        toolSchemaHash: prepared.toolSchemaHash,
      });
      const summary = Object.freeze({
        previousRevisionNumber: snapshot.revision.revisionNumber,
        revisionNumber: revision.revisionNumber,
        changed,
        toolCountBefore: snapshot.surface.toolDefinitions.length,
        toolCountAfter: candidateSurface.toolDefinitions.length,
      });
      await this.append({
        type: "context.revision.finished",
        sessionId: this.sessionId,
        data: {
          strategy: "surface_refresh",
          reason: "resume",
          baseRevisionNumber: summary.previousRevisionNumber,
          revisionNumber: summary.revisionNumber,
          changed: summary.changed,
          toolCountBefore: summary.toolCountBefore,
          toolCountAfter: summary.toolCountAfter,
          measuredAnchorCleared: true,
          durationMs: elapsedMs(startedAt),
        },
      });
      return summary;
    } catch (error) {
      await this.append({
        type: "context.revision.failed",
        sessionId: this.sessionId,
        data: {
          strategy: "surface_refresh",
          reason: "resume",
          stage,
          errorCode: boundedContextErrorCode(
            error instanceof SessionError
              ? error.code
              : error instanceof Error
                ? error.name
                : "CONTEXT_SURFACE_REFRESH_FAILED",
          ),
          error: `Context surface refresh failed at ${stage}.`,
          committed,
        },
      }).catch(() => undefined);
      throw error;
    }
  }

  skills(): RuntimeSkillsSnapshot {
    const activeNames = new Set(
      this.skillCoordinator.activeEntries().map((entry) => entry.skill.name),
    );
    return Object.freeze({
      skills: Object.freeze(
        [...this.skillCatalog.skills.values()]
          .sort((left, right) => compareText(left.name, right.name))
          .map((skill) =>
            Object.freeze({
              name: skill.name,
              description: skill.description,
              scope: skill.scope,
              active: activeNames.has(skill.name),
            }),
          ),
      ),
      shadowedNames: Object.freeze(
        this.skillCatalog.shadowed.map((entry) => entry.name),
      ),
    });
  }

  private requireContextAutomation(): ContextAutomationDecision {
    if (this.contextAutomationDecision === undefined) {
      throw new Error("RuntimeSession context automation is not initialized.");
    }
    return this.contextAutomationDecision;
  }

  private appendSkillsCatalogLoaded(): Promise<void> {
    const activeNames = this.skillCoordinator
      .activeEntries()
      .map((entry) => entry.skill.name);
    if (
      this.skillCatalog.skills.size === 0 &&
      activeNames.length === 0 &&
      this.skillCatalog.shadowed.length === 0
    ) {
      return Promise.resolve();
    }
    const skills = [...this.skillCatalog.skills.values()];
    return this.append({
      type: "skills.catalog.loaded",
      sessionId: this.sessionId,
      data: {
        availableCount: skills.length,
        projectCount: skills.filter((skill) => skill.scope === "project").length,
        userCount: skills.filter((skill) => skill.scope === "user").length,
        activeNames: Object.freeze(activeNames),
        shadowedNames: Object.freeze(
          this.skillCatalog.shadowed.map((entry) => entry.name),
        ),
      },
    });
  }

  private onToolCompletionsCommitted(input: {
    completions: readonly ToolCompletionInput[];
    committed: readonly CommittedToolCompletion[];
  }): void {
    if (input.completions.length !== input.committed.length) {
      throw new Error("Committed tool completion identity count does not match.");
    }
    for (let index = 0; index < input.completions.length; index += 1) {
      const completion = input.completions[index];
      const committed = input.committed[index];
      if (
        completion === undefined ||
        committed === undefined ||
        completion.call.toolCallId !== committed.toolCallId
      ) {
        throw new Error("Committed tool completion identity is invalid.");
      }
      if (
        completion.kind === "returned" &&
        completion.raw.kind === "skill" &&
        completion.raw.ok &&
        completion.raw.status === "loaded"
      ) {
        this.skillCoordinator.markPending(completion.raw.name);
      }
    }
  }

  private prepareModelDispatch(input: {
    iteration: IterationIdentity;
    built: BuiltContextRequest;
  }): void {
    const pending = this.store.loadSkillActivations(["pending"]);
    if (pending.length === 0) {
      return;
    }
    const visibleCanonicalMessageIds = new Set(
      input.built.compiled.entries
        .filter(
          (entry) =>
            entry.representation === "canonical" && entry.message.role === "tool",
        )
        .map((entry) => entry.messageId),
    );
    const included = pending.filter((activation) =>
      visibleCanonicalMessageIds.has(activation.activationMessageId),
    );
    if (included.length === 0) {
      return;
    }
    const dispatched = this.store.markSkillActivationsDispatched({
      iterationId: input.iteration.iterationId,
      activationMessageIds: included.map(
        (activation) => activation.activationMessageId,
      ),
    });
    this.skillCoordinator.markDispatched(
      dispatched.map((activation) => activation.name),
    );
  }

  private async commitSkillSettlements(input: {
    reason: "activation" | "resume";
    unresolved: readonly StoredSkillActivation[];
    candidateSurface?: StoredContextSurfaceV8;
    activated?: readonly string[];
    refreshed?: readonly string[];
    deactivated?: readonly string[];
  }): Promise<SkillsUpdateSummary> {
    if (input.unresolved.length === 0) {
      throw new Error("Agent Skills update requires unresolved activations.");
    }
    const snapshot = this.store.loadContextSnapshot();
    const canonicalMessages = new Map(
      snapshot.canonical.messages.map((message) => [message.messageId, message]),
    );
    const activeByName = new Map(
      this.skillCoordinator
        .activeEntries()
        .map((entry) => [entry.skill.name, entry] as const),
    );
    const activated = new Set(input.activated ?? []);
    const unavailable = new Set<string>();
    const settlements: Array<{
      activationMessageId: StoredSkillActivation["activationMessageId"];
      name: string;
      state: "promoted" | "rejected";
      rejectionReason?: string;
    }> = [];
    const receipts = [];
    for (const activation of [...input.unresolved].sort((left, right) =>
      compareText(left.name, right.name),
    )) {
      const skill = this.skillCatalog.skills.get(activation.name);
      const canPromote = activation.state === "dispatched" && skill !== undefined;
      if (canPromote) {
        const existing = activeByName.get(activation.name);
        if (
          existing !== undefined &&
          existing.activationMessageId !== activation.activationMessageId
        ) {
          throw new Error(
            `Agent Skill ${activation.name} already has another active activation.`,
          );
        }
        activeByName.set(activation.name, {
          skill,
          activationMessageId: activation.activationMessageId,
        });
        activated.add(activation.name);
      }
      const state = canPromote ? "promoted" : "rejected";
      const rejectionReason =
        state === "promoted"
          ? undefined
          : activation.state === "pending"
            ? "not_dispatched"
            : "unavailable";
      if (rejectionReason === "unavailable") {
        unavailable.add(activation.name);
      }
      settlements.push({
        activationMessageId: activation.activationMessageId,
        name: activation.name,
        state,
        ...(rejectionReason === undefined ? {} : { rejectionReason }),
      });
      const message = canonicalMessages.get(activation.activationMessageId);
      if (message?.role !== "tool") {
        throw new Error(
          `Agent Skill activation message ${activation.activationMessageId} is missing.`,
        );
      }
      receipts.push(
        renderSkillActivationReceipt({
          message: {
            messageId: message.messageId,
            frameId: message.frameId,
            ordinal: message.ordinal,
            content: message.content,
            contentSha256: message.contentSha256,
          },
          name: activation.name,
          outcome:
            state === "promoted"
              ? "promoted"
              : rejectionReason === "unavailable"
                ? "unavailable"
                : "rejected",
        }),
      );
    }
    const nextActive = Object.freeze(
      [...activeByName.values()].sort((left, right) =>
        compareText(left.skill.name, right.skill.name),
      ),
    );
    const createdAt = new Date().toISOString();
    const definitions = this.requireTooling().registry.definitions();
    const renderedSystemPrompt = buildActiveSystemPrompt({
      baseSystemPrompt: this.input.systemPrompt,
      activeSkills: nextActive,
    });
    const surfacePrepared = this.input.modelClient.prepare({
      messages: [{ role: "system", content: renderedSystemPrompt }],
      tools: definitions,
    });
    const generatedSurface =
      input.candidateSurface ??
      createContextSurface({
        surfaceId: this.dependencies.idFactory.createContextSurfaceId(),
        sessionId: this.sessionId,
        systemPrompt: renderedSystemPrompt,
        recallContractVersion: CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION,
        ...(this.input.projectInstruction === undefined
          ? {}
          : { projectInstruction: this.input.projectInstruction }),
        skillCatalog: skillCatalogManifest(this.skillCatalog.skills.values()),
        activeSkills: nextActive.map((entry) =>
          activeSkillManifestEntry(entry.skill, entry.activationMessageId),
        ),
        toolDefinitions: definitions,
        prepared: surfacePrepared,
        createdAt,
      });
    assertPreparedMatchesSurface(surfacePrepared, generatedSurface);
    const surface = sameContextSurface(snapshot.surface, generatedSurface)
      ? snapshot.surface
      : generatedSurface;
    const startedAt = performance.now();
    await this.append({
      type: "context.revision.started",
      sessionId: this.sessionId,
      data: {
        strategy: "skills_update",
        reason: input.reason,
        baseRevisionNumber: snapshot.revision.revisionNumber,
        names: Object.freeze(
          input.unresolved.map((entry) => entry.name).sort(compareText),
        ),
      },
    });
    let stage: "prepare" | "commit" | "activate" = "prepare";
    let committed = false;
    try {
      const revision = commitAgentSkillsContextUpdate({
        store: this.store,
        contextMeter: this.contextMeter,
        idFactory: this.dependencies.idFactory,
        snapshot,
        surface,
        addedOverrides: receipts,
        settlements,
      });
      committed = true;
      stage = "activate";
      this.skillCoordinator.replaceActive(nextActive);
      this.skillCoordinator.settle(
        input.unresolved.map((activation) => activation.name),
      );
      const summary = Object.freeze({
        previousRevisionNumber: snapshot.revision.revisionNumber,
        revisionNumber: revision.revisionNumber,
        activated: Object.freeze([...activated].sort()),
        refreshed: Object.freeze([...(input.refreshed ?? [])].sort()),
        deactivated: Object.freeze([...(input.deactivated ?? [])].sort()),
        unavailable: Object.freeze([...unavailable].sort()),
        addedOverrideCount: receipts.length,
      });
      await this.append({
        type: "context.revision.finished",
        sessionId: this.sessionId,
        data: {
          strategy: "skills_update",
          reason: input.reason,
          baseRevisionNumber: summary.previousRevisionNumber,
          revisionNumber: summary.revisionNumber,
          activated: summary.activated,
          refreshed: summary.refreshed,
          deactivated: summary.deactivated,
          unavailable: summary.unavailable,
          addedOverrideCount: summary.addedOverrideCount,
          measuredAnchorCleared: true,
          durationMs: elapsedMs(startedAt),
        },
      });
      return summary;
    } catch (error) {
      if (error instanceof ContextManagerError) {
        committed = error.committed;
        stage =
          error.stage === "commit"
            ? "commit"
            : error.stage === "activate"
              ? "activate"
              : "prepare";
      }
      await this.append({
        type: "context.revision.failed",
        sessionId: this.sessionId,
        data: {
          strategy: "skills_update",
          reason: input.reason,
          stage,
          errorCode: boundedContextErrorCode(
            error instanceof ContextManagerError
              ? error.code
              : error instanceof SessionError
                ? error.code
                : error instanceof Error
                  ? error.name
                  : "SKILLS_UPDATE_VALIDATION_FAILED",
          ),
          error: `Agent Skills update failed at ${stage}.`,
          committed,
        },
      }).catch(() => undefined);
      throw error;
    }
  }

  executeTurn(input: ExecuteTurnInput): Promise<RunAgentResult> {
    if (this.state !== "ready") {
      throw new Error(`Cannot execute a turn while RuntimeSession is ${this.state}.`);
    }
    if (input.userPrompt.trim() === "") {
      throw new Error("Cannot execute a turn with an empty prompt.");
    }
    if (this.activeTurn !== undefined) {
      throw new Error("Cannot execute concurrent turns in one RuntimeSession.");
    }

    let admissionPrepared;
    try {
      admissionPrepared = this.input.modelClient.prepare(
        this.requireLedger().buildCandidateModelRequest(
          input.userPrompt,
          this.requireTooling().registry.definitions(),
        ).request,
      );
    } catch (error) {
      if (isCanonicalRuntimeFault(error)) {
        this.fault(error);
      }
      throw error;
    }
    const admissionSnapshot = this.contextMeter.measure(admissionPrepared);
    this.contextMeter.assertWithinBudget(admissionSnapshot);

    const controller = new AbortController();
    const removeExternalAbortListener = forwardExternalAbort(input.signal, controller);
    const turn = this.stageTurn(input.userPrompt);
    let pendingLedgerTurn;
    try {
      pendingLedgerTurn = this.requireLedger().beginTurn({
        turn,
        userPrompt: input.userPrompt,
      });
      this.registerTurn(turn);
    } catch (error) {
      this.fault(error);
      throw error;
    }
    this.state = "executing";
    const completion = this.performExecuteTurn(
      input.userPrompt,
      turn,
      pendingLedgerTurn,
      controller.signal,
      removeExternalAbortListener,
    );
    this.activeTurn = { controller, completion };
    return completion;
  }

  compactContext(): Promise<ContextCompactionResult> {
    if (this.state !== "ready") {
      throw new Error(`Cannot compact context while RuntimeSession is ${this.state}.`);
    }
    if (this.activeTurn !== undefined) {
      throw new Error("Cannot compact context while a turn is active.");
    }
    const completion = this.performCompactContext();
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

  private async performCompactContext(): Promise<ContextCompactionResult> {
    if (this.state !== "ready") {
      throw new Error(`Cannot compact context while RuntimeSession is ${this.state}.`);
    }
    if (this.activeTurn !== undefined) {
      throw new Error("Cannot compact context while a turn is active.");
    }
    this.store.assertContextRevisionIdle();
    this.state = "compacting";
    let started = false;
    try {
      await this.append({
        type: "context.revision.started",
        sessionId: this.sessionId,
        data: {
          strategy: "swap",
          reason: "manual",
          policyVersion: "swap-only-v1",
          rendererFormat: "swap-observation-v1",
        },
      });
      started = true;
      const result = await this.requireContextManager().compact(
        this.dependencies.manualCompactionTrigger(),
      );
      await this.append({
        type: "context.revision.finished",
        sessionId: this.sessionId,
        data: contextRevisionFinishedData(result),
      });
      if (this.state === "compacting") {
        this.state = "ready";
      }
      return result;
    } catch (error) {
      if (started && !(error instanceof RuntimeEventAppendError)) {
        const failure =
          error instanceof ContextManagerError
            ? error
            : new ContextManagerError(
                "activate",
                error instanceof Error ? error.name : "CONTEXT_COMPACTION_FAILED",
                true,
                false,
                "Context compaction failed.",
                { cause: error },
              );
        await this.append({
          type: "context.revision.failed",
          sessionId: this.sessionId,
          data: {
            strategy: "swap",
            reason: "manual",
            stage: failure.stage,
            errorCode: boundedContextErrorCode(failure.code),
            error: `Context compaction failed at ${failure.stage}.`,
          },
        }).catch(() => undefined);
      }
      if (!(error instanceof ContextManagerError) || error.fatal) {
        this.fault(error);
      } else if (this.state === "compacting") {
        this.state = "ready";
      }
      throw error;
    }
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
    const completion = this.performRetireContext();
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

  private async performRetireContext(): Promise<ContextRetirementResult> {
    if (this.state !== "ready") {
      throw new Error(
        `Cannot retire context prefix while RuntimeSession is ${this.state}.`,
      );
    }
    if (this.activeTurn !== undefined) {
      throw new Error("Cannot retire context prefix while a turn is active.");
    }
    this.store.assertContextRevisionIdle();
    const baseRevisionNumber = this.store.loadContextSnapshot().revision.revisionNumber;
    this.state = "compacting";
    let started = false;
    try {
      await this.append({
        type: "context.revision.started",
        sessionId: this.sessionId,
        data: {
          strategy: "retire_prefix",
          reason: "manual",
          policyVersion: "recall-first-retirement-v1",
          baseRevisionNumber,
        },
      });
      started = true;
      const result = await this.requireContextManager().retirePrefix(
        this.dependencies.manualRetirementTrigger(),
      );
      await this.append({
        type: "context.revision.finished",
        sessionId: this.sessionId,
        data: contextRetirementFinishedData(result),
      });
      if (this.state === "compacting") {
        this.state = "ready";
      }
      return result;
    } catch (error) {
      if (started && !(error instanceof RuntimeEventAppendError)) {
        const failure =
          error instanceof ContextManagerError
            ? error
            : new ContextManagerError(
                "activate",
                error instanceof Error ? error.name : "CONTEXT_RETIREMENT_FAILED",
                true,
                false,
                "Context prefix retirement failed.",
                { cause: error },
              );
        await this.append({
          type: "context.revision.failed",
          sessionId: this.sessionId,
          data: {
            strategy: "retire_prefix",
            reason: "manual",
            stage: failure.stage,
            errorCode: boundedContextErrorCode(failure.code),
            error: `Context prefix retirement failed at ${failure.stage}.`,
            committed: failure.committed,
          },
        }).catch(() => undefined);
      }
      if (!(error instanceof ContextManagerError) || error.fatal) {
        this.fault(error);
      } else if (this.state === "compacting") {
        this.state = "ready";
      }
      throw error;
    }
  }

  dispose(reason: SessionDisposeReason): Promise<void> {
    this.disposePromise ??= this.performDispose(reason);
    return this.disposePromise;
  }

  canSwitchSession(): boolean {
    return (
      this.state === "ready" &&
      this.activeTurn === undefined &&
      (this.tooling?.taskManager
        .listBackgroundTasks()
        .every((task) => task.status !== "running" && task.status !== "stopping") ??
        true)
    );
  }

  private async performExecuteTurn(
    userPrompt: string,
    turn: TurnIdentity,
    pendingLedgerTurn: ReturnType<SessionLedger["beginTurn"]>,
    signal: AbortSignal,
    removeExternalAbortListener: () => void,
  ): Promise<RunAgentResult> {
    let settled = false;

    try {
      await this.append({
        type: "turn.started",
        ...turn,
        data: { userPrompt },
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
                this.requireContextAutomation().automaticSwapOnly
              ) {
                this.pendingAutomaticContextMaintenance = true;
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
          await this.settleClosedTurnSkills();
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
      await this.settleClosedTurnSkills();
      if (result.status === "completed") {
        await this.performAutomaticContextMaintenance();
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
      this.pendingAutomaticContextMaintenance = false;
      if (this.state === "executing") {
        this.state = "ready";
      }
    }
  }

  private async performAutomaticContextMaintenance(): Promise<void> {
    if (!this.pendingAutomaticContextMaintenance) return;
    this.pendingAutomaticContextMaintenance = false;
    const automation = this.requireContextAutomation();
    if (!automation.automaticSwapOnly) return;
    if (this.state !== "executing") {
      throw new Error(
        `Cannot run automatic context maintenance while RuntimeSession is ${this.state}.`,
      );
    }
    this.store.assertContextRevisionIdle();
    const qualificationId = requireAutomationQualificationId(automation);
    this.state = "maintaining_context";
    try {
      const swap = await this.performAutomaticCompaction(qualificationId);
      if (swap === undefined) return;
      if (automation.automaticPrefixRetirement && automaticSwapNeedsRetirement(swap)) {
        await this.performAutomaticRetirement(qualificationId);
      }
    } finally {
      if (this.state === "maintaining_context") {
        this.state = "executing";
      }
    }
  }

  private async performAutomaticCompaction(
    qualificationId: string,
  ): Promise<ContextCompactionResult | undefined> {
    let started = false;
    try {
      await this.append({
        type: "context.revision.started",
        sessionId: this.sessionId,
        data: {
          strategy: "swap",
          reason: "runtime_pressure",
          policyVersion: "swap-only-v1",
          rendererFormat: "swap-observation-v1",
          qualificationId,
        },
      });
      started = true;
      const result = await this.requireContextManager().compact(
        this.dependencies.automaticCompactionTrigger(),
      );
      await this.append({
        type: "context.revision.finished",
        sessionId: this.sessionId,
        data: contextRevisionFinishedData(result, "runtime_pressure", qualificationId),
      });
      return result;
    } catch (error) {
      if (started && !(error instanceof RuntimeEventAppendError)) {
        const failure = automaticContextFailure(error, "compaction");
        await this.append({
          type: "context.revision.failed",
          sessionId: this.sessionId,
          data: {
            strategy: "swap",
            reason: "runtime_pressure",
            stage: failure.stage,
            errorCode: boundedContextErrorCode(failure.code),
            error: `Automatic context compaction failed at ${failure.stage}.`,
            qualificationId,
          },
        }).catch(() => undefined);
      }
      if (error instanceof ContextManagerError && !error.fatal) {
        return undefined;
      }
      throw error;
    }
  }

  private async performAutomaticRetirement(
    qualificationId: string,
  ): Promise<ContextRetirementResult | undefined> {
    const baseRevisionNumber = this.store.loadContextSnapshot().revision.revisionNumber;
    let started = false;
    try {
      await this.append({
        type: "context.revision.started",
        sessionId: this.sessionId,
        data: {
          strategy: "retire_prefix",
          reason: "runtime_pressure",
          policyVersion: "recall-first-retirement-v1",
          baseRevisionNumber,
          qualificationId,
        },
      });
      started = true;
      const result = await this.requireContextManager().retirePrefix(
        this.dependencies.automaticRetirementTrigger(),
      );
      await this.append({
        type: "context.revision.finished",
        sessionId: this.sessionId,
        data: contextRetirementFinishedData(
          result,
          "runtime_pressure",
          qualificationId,
        ),
      });
      return result;
    } catch (error) {
      if (started && !(error instanceof RuntimeEventAppendError)) {
        const failure = automaticContextFailure(error, "retirement");
        await this.append({
          type: "context.revision.failed",
          sessionId: this.sessionId,
          data: {
            strategy: "retire_prefix",
            reason: "runtime_pressure",
            stage: failure.stage,
            errorCode: boundedContextErrorCode(failure.code),
            error: `Automatic context retirement failed at ${failure.stage}.`,
            committed: failure.committed,
            qualificationId,
          },
        }).catch(() => undefined);
      }
      if (error instanceof ContextManagerError && !error.fatal) {
        return undefined;
      }
      throw error;
    }
  }

  private async settleClosedTurnSkills(): Promise<void> {
    const unresolved = this.store.loadSkillActivations(["pending", "dispatched"]);
    if (unresolved.length === 0) {
      return;
    }
    const summary = await this.commitSkillSettlements({
      reason: "activation",
      unresolved,
    });
    await this.append({
      type: "skills.updated",
      sessionId: this.sessionId,
      data: {
        reason: "activation",
        activated: summary.activated,
        refreshed: summary.refreshed,
        deactivated: summary.deactivated,
        unavailable: summary.unavailable,
        revisionNumber: summary.revisionNumber,
      },
    });
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
    const errors: unknown[] = this.faultCause === undefined ? [] : [this.faultCause];
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

  private stageTurn(userPrompt: string): TurnIdentity {
    if (userPrompt.trim() === "") {
      throw new Error("Cannot create an AgentTurn for an empty prompt.");
    }

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

function createEventSink(input: CreateRuntimeSessionInput): EventSink {
  const requiredSinks: EventSink[] = [];
  if (input.persistence !== false) {
    const basePath = path.join(
      input.workspaceRoot,
      ".tinker",
      "sessions",
      input.selection.sessionId,
    );
    requiredSinks.push(
      new JsonlEventLog(
        input.persistence?.eventLogPath ?? path.join(basePath, "events.jsonl"),
      ),
      new ObservationTextLog(
        input.persistence?.observationLogPath ?? path.join(basePath, "observations.md"),
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

function assertPreparedMatchesSurface(
  prepared: ReturnType<ModelClient["prepare"]>,
  surface: StoredContextSurfaceV8,
): void {
  if (
    prepared.requestConfigHash !== surface.requestConfigSha256 ||
    prepared.toolSchemaHash !== surface.toolSchemaSha256 ||
    prepared.requestMaxOutputTokens !== surface.requestMaxOutputTokens
  ) {
    throw new Error("Prepared model request does not match its context surface.");
  }
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function isNewSessionInput(
  input: CreateRuntimeSessionInput,
): input is CreateNewRuntimeSessionInput {
  return input.selection.mode === "new";
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

function contextRevisionFinishedData(
  result: ContextCompactionResult,
  reason: "manual" | "runtime_pressure" = "manual",
  qualificationId?: string,
): ContextRevisionFinishedData {
  if (result.status === "unchanged") {
    return {
      strategy: "swap",
      reason,
      policyVersion: "swap-only-v1",
      outcome: result.outcome,
      baseRevisionNumber: result.revisionNumber,
      addedOverrideCount: 0,
      activeOverrideCount: result.activeOverrideCount,
      originalObservationBytes: 0,
      projectedObservationBytes: 0,
      rawTokensBefore: result.rawTokensBefore,
      guardedTokensBefore: result.guardedTokensBefore,
      targetTokens: result.targetTokens,
      durationMs: result.durationMs,
      ...(qualificationId === undefined ? {} : { qualificationId }),
    };
  }
  return {
    strategy: "swap",
    reason,
    policyVersion: "swap-only-v1",
    outcome: result.outcome,
    baseRevisionNumber: result.previousRevisionNumber,
    revisionNumber: result.revisionNumber,
    addedOverrideCount: result.addedOverrideCount,
    activeOverrideCount: result.activeOverrideCount,
    originalObservationBytes: result.originalObservationBytes,
    projectedObservationBytes: result.projectedObservationBytes,
    rawTokensBefore: result.rawTokensBefore,
    rawTokensAfter: result.rawTokensAfter,
    guardedTokensBefore: result.guardedTokensBefore,
    guardedTokensAfter: result.guardedTokensAfter,
    targetTokens: result.targetTokens,
    planHash: result.planHash,
    durationMs: result.durationMs,
    ...(qualificationId === undefined ? {} : { qualificationId }),
  };
}

function contextRetirementFinishedData(
  result: ContextRetirementResult,
  reason: "manual" | "runtime_pressure" = "manual",
  qualificationId?: string,
): ContextRevisionFinishedData {
  if (result.status === "unchanged") {
    return {
      strategy: "retire_prefix",
      reason,
      policyVersion: "recall-first-retirement-v1",
      outcome: result.outcome,
      baseRevisionNumber: result.revisionNumber,
      previousKeepFromOrdinal: result.keepFromOrdinal,
      keepFromOrdinal: result.keepFromOrdinal,
      retiredTurnCount: 0,
      retiredFrameCount: 0,
      retiredMessageCount: 0,
      activeOverrideCount: result.activeOverrideCount,
      guardedTokensBefore: result.guardedTokensBefore,
      targetTokens: result.targetTokens,
      planningDurationMs: result.planningDurationMs,
      durationMs: result.durationMs,
      ...(qualificationId === undefined ? {} : { qualificationId }),
    };
  }
  return {
    strategy: "retire_prefix",
    reason,
    policyVersion: "recall-first-retirement-v1",
    outcome: result.outcome,
    baseRevisionNumber: result.previousRevisionNumber,
    revisionNumber: result.revisionNumber,
    previousKeepFromOrdinal: result.previousKeepFromOrdinal,
    keepFromOrdinal: result.keepFromOrdinal,
    retiredTurnCount: result.retiredTurnCount,
    retiredFrameCount: result.retiredFrameCount,
    retiredMessageCount: result.retiredMessageCount,
    activeOverrideCount: result.activeOverrideCount,
    rawTokensBefore: result.rawTokensBefore,
    rawTokensAfter: result.rawTokensAfter,
    guardedTokensBefore: result.guardedTokensBefore,
    guardedTokensAfter: result.guardedTokensAfter,
    targetTokens: result.targetTokens,
    planHash: result.planHash,
    planningDurationMs: result.planningDurationMs,
    validationDurationMs: result.validationDurationMs,
    transactionDurationMs: result.transactionDurationMs,
    activationDurationMs: result.activationDurationMs,
    durationMs: result.durationMs,
    ...(qualificationId === undefined ? {} : { qualificationId }),
  };
}

function requireAutomationQualificationId(decision: ContextAutomationDecision): string {
  if (
    !decision.automaticSwapOnly ||
    (decision.reason !== "qualified" && decision.reason !== "swap_only_qualified") ||
    decision.qualificationId === undefined
  ) {
    throw new Error("Automatic context maintenance has no qualification identity.");
  }
  return decision.qualificationId;
}

function automaticSwapNeedsRetirement(result: ContextCompactionResult): boolean {
  return (
    result.outcome === "no_eligible_candidates" ||
    result.outcome === "insufficient_candidates"
  );
}

function automaticContextFailure(
  error: unknown,
  strategy: "compaction" | "retirement",
): ContextManagerError {
  return error instanceof ContextManagerError
    ? error
    : new ContextManagerError(
        "activate",
        error instanceof Error
          ? error.name
          : `AUTOMATIC_CONTEXT_${strategy.toUpperCase()}_FAILED`,
        true,
        false,
        `Automatic context ${strategy} failed.`,
        { cause: error },
      );
}

function boundedContextErrorCode(code: string): string {
  return /^[A-Za-z0-9_]+$/.test(code) && code.length <= 80
    ? code
    : "CONTEXT_COMPACTION_FAILED";
}

function requirePositiveNumber(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer; received ${value}.`);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
