import {
  canonicalSequenceHash,
  renderedMessageHash,
} from "../context/compiled-context-hash";
import {
  commitAgentSkillsContextUpdate,
  ContextManagerError,
} from "../context/context-manager";
import type { BuiltContextRequest } from "../context/context-revision";
import { ContextRevisionCompiler } from "../context/context-revision-compiler";
import {
  changedContextSurfaceComponents,
  contextSurfaceChangeManifestHash,
  contextSurfaceChanges,
  createContextSurface,
  sameContextSurface,
  type StoredContextSurfaceV8,
} from "../context/context-surface";
import type { ToolCompletionInput } from "../context/protocol-frame";
import { CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION } from "../context/recall-retirement-contract";
import type { AgentEventInput } from "../events/types";
import { type RuntimeIdFactory, type SessionId } from "../ids/runtime-id";
import { SessionError } from "../session/session-errors";
import type { SessionStore, StoredSkillActivation } from "../session/session-store";
import {
  activeSkillManifestEntry,
  skillCatalogManifest,
} from "../skills/skill-catalog";
import {
  buildActiveSystemPrompt,
  renderSkillActivationReceipt,
  SkillActivationCoordinator,
} from "../skills/skill-context";
import type { SkillCatalogSnapshot } from "../skills/skill-loader";
import { type DefaultTooling } from "../tools/registry";
import type { ContextMeter } from "./context-meter";
import {
  assertPreparedMatchesSurface,
  boundedContextErrorCode,
  elapsedMs,
} from "./runtime-context-events";
import {
  type ContextSurfaceRefreshSummary,
  type CreateRuntimeSessionInput,
  type RuntimeSkillsSnapshot,
  type SkillsUpdateSummary,
} from "./runtime-session-contracts";
import type { CommittedToolCompletion } from "./session-ledger";
import type { IterationIdentity } from "./types";

/** Coordinates skill activation and the corresponding persisted context surface. */
export class RuntimeSkills {
  private skillCoordinator = new SkillActivationCoordinator();
  get coordinator(): SkillActivationCoordinator {
    return this.skillCoordinator;
  }

  restoreCoordinator(coordinator: SkillActivationCoordinator): void {
    this.skillCoordinator = coordinator;
  }

  constructor(
    private readonly sessionId: SessionId,
    private readonly store: SessionStore,
    private readonly input: Pick<
      CreateRuntimeSessionInput,
      "systemPrompt" | "projectInstruction" | "modelClient"
    >,
    private readonly skillCatalog: SkillCatalogSnapshot,
    private readonly idFactory: RuntimeIdFactory,
    private readonly contextMeter: ContextMeter,
    private readonly toolDefinitions: DefaultTooling["registry"]["definitions"],
    private readonly append: (event: AgentEventInput) => Promise<void>,
  ) {}

  async refreshContextSurface(
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
        revisionId: this.idFactory.createContextRevisionId(),
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

  appendSkillsCatalogLoaded(): Promise<void> {
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

  onToolCompletionsCommitted(input: {
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

  async commitSkillSettlements(input: {
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
            content: message.displayText,
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
    const definitions = this.toolDefinitions();
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
        surfaceId: this.idFactory.createContextSurfaceId(),
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
        idFactory: this.idFactory,
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

  async settleClosedTurnSkills(): Promise<void> {
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

  markModelDispatch(input: {
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
}
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
