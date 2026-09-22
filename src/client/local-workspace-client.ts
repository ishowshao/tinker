import type {
  RuntimeSession,
  SessionDisposeReason,
  ExecuteTurnInput,
} from "../agent/runtime-session";
import type { SessionId } from "../ids/runtime-id";
import { createUuidV7 } from "../ids/uuid-v7";
import type { ClientModelProfile } from "./model-catalog";
import type { SessionCatalog, SessionSummary } from "../session/session-catalog";
import { readLastAssistantResponse } from "../session/session-last-response-reader";
import type {
  ContextCompactionResult,
  ContextRetirementResult,
} from "../context/context-manager";
import type { TurnUndoResult } from "../tools/turn-undo-manager";
import type { SessionClient, WorkspaceClient } from "./session-client";

export type OwnedSessionBinding<View> = {
  client: SessionClient<View>;
  runtimeSession: RuntimeSession;
};

export class LocalWorkspaceClient<View> implements WorkspaceClient<View> {
  private readonly listeners = new Set<() => void>();
  private binding: OwnedSessionBinding<View>;
  private operation?: Promise<unknown>;

  constructor(
    initial: OwnedSessionBinding<View>,
    private readonly catalog: SessionCatalog,
    private readonly openSession: (
      sessionId: SessionId,
    ) => Promise<OwnedSessionBinding<View>>,
    private readonly createSessionWithProfile: (
      profile: ClientModelProfile,
    ) => Promise<OwnedSessionBinding<View>>,
    private readonly createFreshSession: (
      current: SessionClient<View>,
    ) => Promise<OwnedSessionBinding<View>>,
  ) {
    this.binding = initial;
  }

  readonly getBinding = (): SessionClient<View> => this.binding.client;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  listSessions(): Promise<readonly SessionSummary[]> {
    return this.catalog.listAll(this.binding.client.sessionId);
  }

  compact(): Promise<ContextCompactionResult> {
    return this.serialize(() => this.binding.runtimeSession.compactContext());
  }

  retire(): Promise<ContextRetirementResult> {
    return this.serialize(() => this.binding.runtimeSession.retireContext());
  }

  undo(): Promise<TurnUndoResult> {
    return this.serialize(() =>
      this.binding.runtimeSession.undoLatestFileMutationTurn(),
    );
  }

  fork(beforeCommit?: () => void): Promise<SessionId> {
    return this.serialize(async () => {
      const targetSessionId = createUuidV7() as SessionId;
      await this.replaceSession(
        "Cannot clone the session while a turn, context operation, or background task is active.",
        async (current) => {
          await current.runtimeSession.cloneSession(targetSessionId);
          return this.openSession(targetSessionId);
        },
        beforeCommit,
      );
      return targetSessionId;
    });
  }

  clear(beforeCommit?: () => void): Promise<void> {
    return this.serialize(() =>
      this.replaceSession(
        "Cannot clear the session while a turn, context operation, or background task is active.",
        (current) => this.createFreshSession(current.client),
        beforeCommit,
      ),
    );
  }

  resume(sessionId: SessionId, beforeCommit?: () => void): Promise<void> {
    return this.serialize(async () => {
      if (sessionId === this.binding.client.sessionId) {
        throw new Error(`Session ${sessionId} is already current.`);
      }
      await this.replaceSession(
        "Cannot switch sessions while a turn or background task is active.",
        () => this.openSession(sessionId),
        beforeCommit,
      );
    });
  }

  delete(sessionId: SessionId): Promise<void> {
    return this.serialize(() =>
      this.catalog.delete(sessionId, this.binding.client.sessionId),
    );
  }

  switchModel(profile: ClientModelProfile, beforeCommit?: () => void): Promise<void> {
    return this.serialize(() =>
      this.replaceSession(
        "Cannot switch models while a turn or background task is active.",
        () => this.createSessionWithProfile(profile),
        beforeCommit,
      ),
    );
  }

  dispose(reason: SessionDisposeReason): Promise<void> {
    return this.binding.runtimeSession.dispose(reason);
  }

  private async replaceSession(
    unavailableMessage: string,
    createTarget: (
      current: OwnedSessionBinding<View>,
    ) => Promise<OwnedSessionBinding<View>>,
    beforeCommit?: () => void,
  ): Promise<void> {
    const current = this.binding;
    if (!current.runtimeSession.canSwitchSession()) {
      throw new Error(unavailableMessage);
    }

    const target = await createTarget(current);
    try {
      await current.runtimeSession.dispose({ type: "session_switch" });
    } catch (error) {
      await target.runtimeSession
        .dispose({ type: "runner_failed", error: errorMessage(error) })
        .catch(() => undefined);
      throw error;
    }
    beforeCommit?.();
    this.binding = target;
    for (const listener of this.listeners) {
      listener();
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.operation !== undefined) {
      return Promise.reject(new Error("Another session operation is already running."));
    }
    const pending = operation().finally(() => {
      if (this.operation === pending) {
        this.operation = undefined;
      }
    });
    this.operation = pending;
    return pending;
  }
}

export function createLocalSessionBinding<View>(input: {
  runtimeSession: RuntimeSession;
  modelName: string;
  workspaceRoot: string;
  profileName?: string;
  projectionStore: View;
}): OwnedSessionBinding<View> {
  return {
    runtimeSession: input.runtimeSession,
    client: {
      sessionId: input.runtimeSession.sessionId,
      modelName: input.modelName,
      workspaceRoot: input.workspaceRoot,
      profileName: input.profileName,
      projectionStore: input.projectionStore,
      readLastResponse: () =>
        readLastAssistantResponse({
          workspaceRoot: input.workspaceRoot,
          sessionId: input.runtimeSession.sessionId,
        }),
      skills: () => input.runtimeSession.skills(),
      mcp: () => input.runtimeSession.mcp(),
      reasoningEffort: () => input.runtimeSession.reasoningEffort(),
      setReasoningEffort: async (effort) =>
        input.runtimeSession.setReasoningEffort(effort),
      resetReasoningEffort: async () => input.runtimeSession.resetReasoningEffort(),
      supportsImageInput: () => input.runtimeSession.supportsImageInput(),
      importImage: (sourcePath, signal, prospectiveMessageImageCount) =>
        input.runtimeSession.importImage(
          sourcePath,
          signal,
          prospectiveMessageImageCount,
        ),
      verifyImageAssets: (assets, signal) =>
        input.runtimeSession.verifyImageAssets(assets, signal),
      admitTurn: (userMessage, signal) =>
        input.runtimeSession.admitTurn({ userMessage, signal }),
      executeTurn: (userMessage, signal) =>
        input.runtimeSession.executeTurn({
          userMessage,
          signal,
        } satisfies ExecuteTurnInput),
      promptScheduler: () => input.runtimeSession.promptScheduler(),
      subscribePromptScheduler: (listener) =>
        input.runtimeSession.subscribePromptScheduler(listener),
      queueFollowUp: async (userMessage) =>
        input.runtimeSession.queueFollowUp(userMessage),
      bashGuard: () => input.runtimeSession.bashGuard(),
      subscribeBashGuard: (listener) =>
        input.runtimeSession.subscribeBashGuard(listener),
      setYoloMode: async (enabled) => input.runtimeSession.setYoloMode(enabled),
      resolveBashConfirmation: (decision) =>
        input.runtimeSession.resolveBashConfirmation(decision),
      providerRetry: () => input.runtimeSession.providerRetry(),
      subscribeProviderRetry: (listener) =>
        input.runtimeSession.subscribeProviderRetry(listener),
      resolveProviderRetry: (requestId, decision) =>
        input.runtimeSession.resolveProviderRetry(requestId, decision),
      askUser: () => input.runtimeSession.askUser(),
      subscribeAskUser: (listener) => input.runtimeSession.subscribeAskUser(listener),
      resolveAskUser: (response) => input.runtimeSession.resolveAskUser(response),
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
