import type {
  ExecuteTurnInput,
  RuntimeSession,
  SessionDisposeReason,
} from "../agent/runtime-session";
import type { RunAgentResult } from "../agent/types";
import type { SessionId } from "../ids/runtime-id";
import { SessionCatalog, type SessionSummary } from "../session/session-catalog";
import type { TuiProjectionStore } from "./tui-projection-store";

export type TuiSessionBinding = {
  sessionId: SessionId;
  modelName: string;
  workspaceRoot: string;
  projectionStore: TuiProjectionStore;
  executeTurn(userPrompt: string, signal: AbortSignal): Promise<RunAgentResult>;
};

export type TuiSessionController = {
  getBinding: () => TuiSessionBinding;
  subscribe: (listener: () => void) => () => void;
  listSessions: () => Promise<readonly SessionSummary[]>;
  resume: (sessionId: SessionId) => Promise<void>;
  delete: (sessionId: SessionId) => Promise<void>;
};

export type ManagedTuiSessionBinding = TuiSessionBinding & {
  runtimeSession: RuntimeSession;
};

export class DefaultTuiSessionController implements TuiSessionController {
  private readonly listeners = new Set<() => void>();
  private binding: ManagedTuiSessionBinding;
  private operation?: Promise<void>;

  constructor(
    initial: ManagedTuiSessionBinding,
    private readonly catalog: SessionCatalog,
    private readonly openSession: (
      sessionId: SessionId,
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

  resume(sessionId: SessionId): Promise<void> {
    return this.serialize(async () => {
      const current = this.binding;
      if (sessionId === current.sessionId) {
        throw new Error(`Session ${sessionId} is already current.`);
      }
      if (!current.runtimeSession.canSwitchSession()) {
        throw new Error(
          "Cannot switch sessions while a turn or background task is active.",
        );
      }

      const target = await this.openSession(sessionId);
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
    });
  }

  delete(sessionId: SessionId): Promise<void> {
    return this.serialize(() => this.catalog.delete(sessionId, this.binding.sessionId));
  }

  dispose(reason: SessionDisposeReason): Promise<void> {
    return this.binding.runtimeSession.dispose(reason);
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
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
  projectionStore: TuiProjectionStore;
}): ManagedTuiSessionBinding {
  return {
    sessionId: input.runtimeSession.sessionId,
    modelName: input.modelName,
    workspaceRoot: input.workspaceRoot,
    projectionStore: input.projectionStore,
    runtimeSession: input.runtimeSession,
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
