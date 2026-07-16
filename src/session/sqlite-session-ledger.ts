import type { RuntimeIdFactory } from "../ids/runtime-id";
import type { ToolDefinition } from "../tools/types";
import type { ProtocolContextView } from "../context/protocol-frame";
import type { BuiltContextRequest } from "../context/context-revision";
import {
  InMemorySessionLedger,
  type AgentTurnLedger,
  type PendingLedgerTurn,
  type SessionLedger,
} from "../agent/session-ledger";
import type { RunAgentResult, TurnIdentity } from "../agent/types";
import type { SessionStore } from "./session-store";

export class SqliteSessionLedger implements SessionLedger {
  private active?: SqlitePendingLedgerTurn;
  private faulted = false;

  constructor(
    private readonly store: SessionStore,
    private readonly idFactory: RuntimeIdFactory,
  ) {}

  beginTurn(input: { turn: TurnIdentity; userPrompt: string }): PendingLedgerTurn {
    this.requireAvailable("begin a turn");
    if (this.active !== undefined) {
      throw new Error("Cannot begin a SQLite ledger turn while another turn is open.");
    }
    const core = this.createCore();
    const inner = core.beginTurn(input);
    const pending = new SqlitePendingLedgerTurn(core, inner, (faulted) => {
      if (this.active !== pending) {
        throw new Error("SQLite ledger pending turn ownership was lost.");
      }
      this.active = undefined;
      this.faulted ||= faulted;
    });
    this.active = pending;
    return pending;
  }

  buildCommittedModelRequest(tools: readonly ToolDefinition[]): BuiltContextRequest {
    this.requireAvailable("build committed context");
    if (this.active !== undefined) {
      throw new Error("Cannot build committed context while a turn is open.");
    }
    return this.createCore().buildCommittedModelRequest(tools);
  }

  buildCandidateModelRequest(
    userPrompt: string,
    tools: readonly ToolDefinition[],
  ): BuiltContextRequest {
    this.requireAvailable("build candidate context");
    if (this.active !== undefined) {
      throw new Error("Cannot build candidate context while a turn is open.");
    }
    return this.createCore().buildCandidateModelRequest(userPrompt, tools);
  }

  committedMessageCount(): number {
    this.requireAvailable("read committed message count");
    return this.store.loadProtocolView().messages.length;
  }

  snapshot(
    options: {
      fullIntegrity?: boolean;
      allowOpenTail?: boolean;
      allowFaulted?: boolean;
    } = {},
  ): ProtocolContextView {
    if (this.active !== undefined) {
      return this.active.snapshot(options);
    }
    if (this.faulted && options.allowFaulted !== true) {
      throw new Error("Cannot read a faulted SQLite session ledger.");
    }
    return this.store.validateAll({
      allowOpenTail: options.allowOpenTail === true,
    });
  }

  fault(error: unknown): void {
    this.faulted = true;
    this.active?.fault(error);
  }

  private createCore(): InMemorySessionLedger {
    return new InMemorySessionLedger({
      sessionId: this.store.sessionId,
      idFactory: this.idFactory,
      initialSnapshot: this.store.loadContextSnapshot(),
      committer: this.store,
    });
  }

  private requireAvailable(action: string): void {
    if (this.faulted) {
      throw new Error(`Cannot ${action} after the SQLite session ledger faulted.`);
    }
  }
}

class SqlitePendingLedgerTurn implements PendingLedgerTurn {
  readonly agent: AgentTurnLedger;
  private settled = false;

  constructor(
    private readonly core: InMemorySessionLedger,
    private readonly inner: PendingLedgerTurn,
    private readonly settleOwner: (faulted: boolean) => void,
  ) {
    this.agent = inner.agent;
  }

  projectedMessageCount(): number {
    return this.inner.projectedMessageCount();
  }

  finish(result: RunAgentResult): void {
    this.requireOpen("finish");
    this.inner.finish(result);
    this.settle(false);
  }

  fault(error: unknown): void {
    this.requireOpen("fault");
    try {
      this.inner.fault(error);
    } finally {
      this.settle(true);
    }
  }

  snapshot(options: {
    fullIntegrity?: boolean;
    allowOpenTail?: boolean;
    allowFaulted?: boolean;
  }): ProtocolContextView {
    return this.core.snapshot(options);
  }

  private settle(faulted: boolean): void {
    this.settled = true;
    this.settleOwner(faulted);
  }

  private requireOpen(action: string): void {
    if (this.settled) {
      throw new Error(`Cannot ${action} after the SQLite ledger turn settled.`);
    }
  }
}
