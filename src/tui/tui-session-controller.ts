import type {
  ContextCompactionResult,
  ContextRetirementResult,
} from "../context/context-manager";
import type {
  ExecuteTurnInput,
  RuntimeSession,
  RuntimeSkillsSnapshot,
  SessionDisposeReason,
} from "../agent/runtime-session";
import type { RunAgentResult } from "../agent/types";
import type { SessionId } from "../ids/runtime-id";
import type { ModelProfile } from "../cli/model-profiles";
import { SessionCatalog, type SessionSummary } from "../session/session-catalog";
import type { TuiProjectionStore } from "./tui-projection-store";

export type TuiSessionBinding = {
  sessionId: SessionId;
  modelName: string;
  workspaceRoot: string;
  profileName?: string;
  projectionStore: TuiProjectionStore;
  skills(): RuntimeSkillsSnapshot;
  executeTurn(userPrompt: string, signal: AbortSignal): Promise<RunAgentResult>;
};

export type TuiSessionController = {
  getBinding: () => TuiSessionBinding;
  subscribe: (listener: () => void) => () => void;
  listSessions: () => Promise<readonly SessionSummary[]>;
  compact: () => Promise<ContextCompactionResult>;
  retire: () => Promise<ContextRetirementResult>;
  clear: () => Promise<void>;
  resume: (sessionId: SessionId) => Promise<void>;
  delete: (sessionId: SessionId) => Promise<void>;
  switchModel: (profile: ModelProfile) => Promise<void>;
};

export type ManagedTuiSessionBinding = TuiSessionBinding & {
  runtimeSession: RuntimeSession;
};

export class DefaultTuiSessionController implements TuiSessionController {
  private readonly listeners = new Set<() => void>();
  private binding: ManagedTuiSessionBinding;
  private operation?: Promise<unknown>;

  constructor(
    initial: ManagedTuiSessionBinding,
    private readonly catalog: SessionCatalog,
    private readonly openSession: (
      sessionId: SessionId,
    ) => Promise<ManagedTuiSessionBinding>,
    private readonly createSessionWithProfile: (
      profile: ModelProfile,
    ) => Promise<ManagedTuiSessionBinding>,
    private readonly createFreshSession: (
      current: TuiSessionBinding,
    ) => Promise<ManagedTuiSessionBinding>,
  ) {
    this.binding = initial;
  }

  readonly getBinding = (): TuiSessionBinding => this.binding;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  listSessions(): Promise<readonly SessionSummary[]> {
    return this.catalog.list(this.binding.sessionId);
  }

  compact(): Promise<ContextCompactionResult> {
    return this.serialize(() => this.binding.runtimeSession.compactContext());
  }

  retire(): Promise<ContextRetirementResult> {
    return this.serialize(() => this.binding.runtimeSession.retireContext());
  }

  clear(): Promise<void> {
    return this.serialize(() =>
      this.replaceSession(
        "Cannot clear the session while a turn, context operation, or background task is active.",
        (current) => this.createFreshSession(current),
      ),
    );
  }

  resume(sessionId: SessionId): Promise<void> {
    return this.serialize(async () => {
      if (sessionId === this.binding.sessionId) {
        throw new Error(`Session ${sessionId} is already current.`);
      }
      await this.replaceSession(
        "Cannot switch sessions while a turn or background task is active.",
        () => this.openSession(sessionId),
      );
    });
  }

  delete(sessionId: SessionId): Promise<void> {
    return this.serialize(() => this.catalog.delete(sessionId, this.binding.sessionId));
  }

  switchModel(profile: ModelProfile): Promise<void> {
    return this.serialize(() =>
      this.replaceSession(
        "Cannot switch models while a turn or background task is active.",
        () => this.createSessionWithProfile(profile),
      ),
    );
  }

  dispose(reason: SessionDisposeReason): Promise<void> {
    return this.binding.runtimeSession.dispose(reason);
  }

  private async replaceSession(
    unavailableMessage: string,
    createTarget: (
      current: ManagedTuiSessionBinding,
    ) => Promise<ManagedTuiSessionBinding>,
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

export function managedTuiBinding(input: {
  runtimeSession: RuntimeSession;
  modelName: string;
  workspaceRoot: string;
  profileName?: string;
  projectionStore: TuiProjectionStore;
}): ManagedTuiSessionBinding {
  return {
    sessionId: input.runtimeSession.sessionId,
    modelName: input.modelName,
    workspaceRoot: input.workspaceRoot,
    profileName: input.profileName,
    projectionStore: input.projectionStore,
    runtimeSession: input.runtimeSession,
    skills: () => input.runtimeSession.skills(),
    executeTurn: (userPrompt, signal) =>
      input.runtimeSession.executeTurn({
        userPrompt,
        signal,
      } satisfies ExecuteTurnInput),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
