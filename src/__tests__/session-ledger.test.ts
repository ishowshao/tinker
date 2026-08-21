import { describe, expect, test } from "bun:test";
import { InMemorySessionLedger } from "../agent/session-ledger";
import type { IterationIdentity, ToolCall, TurnIdentity } from "../agent/types";
import { textToolResultContent } from "../agent/tool-result-content";
import { contentHash, interruptedCompletionInputs } from "../context/protocol-frame";
import { deterministicIdFactory } from "./test-runtime";

describe("InMemorySessionLedger", () => {
  test("records immutable canonical frames and byte-stable messages", () => {
    const fixture = createLedgerFixture("canonical");
    const pending = fixture.ledger.beginTurn({
      turn: fixture.turn,
      userMessage: { role: "user", content: "hello" },
    });
    const args = { file_path: "README.md", nested: { value: 1 } };
    const call = fixture.toolCall(fixture.iteration, 1, "provider-read", "Read", args);
    pending.agent.appendAssistant({
      iteration: fixture.iteration,
      message: {
        role: "assistant",
        content: "checking",
        toolCalls: [call],
      },
      provider: "test",
      model: "test-model",
    });
    args.nested.value = 99;
    pending.agent.commitToolCompletions([
      {
        call,
        kind: "returned",
        raw: {
          kind: "read",
          ok: true,
          filePath: "README.md",
          content: "contents",
        },
        observation: textToolResultContent("Read succeeded."),
      },
    ]);

    const finalIteration = fixture.iterationIdentity(2);
    pending.agent.appendAssistant({
      iteration: finalIteration,
      message: { role: "assistant", content: "done" },
      provider: "test",
      model: "test-model",
    });
    pending.finish({
      status: "completed",
      finalText: "done",
      lastIteration: finalIteration,
    });

    const snapshot = fixture.ledger.snapshot({ fullIntegrity: true });
    expect(snapshot.messages.map((message) => message.ordinal)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(snapshot.frames.map((frame) => [frame.kind, frame.state])).toEqual([
      ["system", "closed"],
      ["user", "closed"],
      ["tool_exchange", "closed"],
      ["assistant_text", "closed"],
    ]);
    expect(snapshot.messages[1]?.contentSha256).toBe(contentHash("hello"));
    const rebuilt = fixture.ledger.buildCommittedModelRequest([]).request.messages;
    expect(
      rebuilt.find((message) => message.role === "assistant")?.toolCalls?.[0]?.args,
    ).toEqual({ file_path: "README.md", nested: { value: 1 } });
    rebuilt.push({ role: "user", content: "mutated" });
    expect(fixture.ledger.buildCommittedModelRequest([]).request.messages).toHaveLength(
      5,
    );
    expect(Object.isFrozen(snapshot.messages)).toBe(true);
    expect(Object.isFrozen(snapshot.messages[2])).toBe(true);
  });

  test("keeps a tool exchange open until every call completes in order", () => {
    const fixture = createLedgerFixture("ordered-tools");
    const pending = fixture.ledger.beginTurn({
      turn: fixture.turn,
      userMessage: { role: "user", content: "run" },
    });
    const first = fixture.toolCall(fixture.iteration, 1, "provider-a", "Read", {});
    const second = fixture.toolCall(fixture.iteration, 2, "provider-b", "Glob", {});
    pending.agent.appendAssistant({
      iteration: fixture.iteration,
      message: { role: "assistant", toolCalls: [first, second] },
      provider: "test",
      model: "test-model",
    });

    expect(() => pending.agent.buildModelRequest([])).toThrow("is open");
    expect(() =>
      pending.agent.commitToolCompletions([
        {
          call: second,
          kind: "synthetic",
          reason: "skipped_after_failure",
        },
      ]),
    ).toThrow("does not match expected call");
    expect(fixture.ledger.snapshot({ allowOpenTail: true }).messages).toHaveLength(3);

    pending.agent.assertCanExecuteTool(first);
    pending.agent.commitToolCompletions([
      {
        call: first,
        kind: "synthetic",
        reason: "cancelled_active",
      },
    ]);
    expect(fixture.ledger.snapshot({ allowOpenTail: true }).frames.at(-1)?.state).toBe(
      "open",
    );
    pending.agent.commitToolCompletions([
      {
        call: second,
        kind: "synthetic",
        reason: "skipped_after_cancel",
      },
    ]);
    expect(fixture.ledger.snapshot().frames.at(-1)?.state).toBe("closed");
  });

  test("faults without a partial append when a completion commit fails", () => {
    const ids = deterministicIdFactory("atomic");
    const sessionId = ids.createSessionId();
    const ledger = new InMemorySessionLedger({
      sessionId,
      systemPrompt: "system",
      idFactory: ids,
      committer: {
        commit(mutation) {
          if (mutation.kind === "commit_tool_completions") {
            throw new Error("database full");
          }
        },
      },
    });
    const turn: TurnIdentity = {
      sessionId,
      turnId: ids.createTurnId(),
      turnNumber: 1,
    };
    const iteration: IterationIdentity = {
      ...turn,
      iterationId: ids.createIterationId(),
      iterationNumber: 1,
    };
    const call: ToolCall = {
      ...iteration,
      toolCallId: ids.createToolCallId(),
      toolCallNumber: 1,
      providerToolCallId: "provider-call",
      name: "Read",
      args: {},
    };
    const pending = ledger.beginTurn({
      turn,
      userMessage: { role: "user", content: "run" },
    });
    pending.agent.appendAssistant({
      iteration,
      message: { role: "assistant", toolCalls: [call] },
      provider: "test",
      model: "test-model",
    });

    expect(() =>
      pending.agent.commitToolCompletions([
        {
          call,
          kind: "synthetic",
          reason: "cancelled_active",
        },
      ]),
    ).toThrow("commit failed");
    const snapshot = ledger.snapshot({
      allowFaulted: true,
      allowOpenTail: true,
      fullIntegrity: true,
    });
    expect(snapshot.messages).toHaveLength(3);
    expect(snapshot.toolResults).toHaveLength(0);
    expect(snapshot.frames.at(-1)?.state).toBe("open");
    expect(() =>
      ledger.buildCandidateModelRequest({ role: "user", content: "next" }, []),
    ).toThrow("ledger faulted");
  });

  test("builds deterministic interrupted completions without retrying calls", () => {
    const fixture = createLedgerFixture("interrupted");
    const calls = [
      fixture.toolCall(fixture.iteration, 1, "a", "Read", {}),
      fixture.toolCall(fixture.iteration, 2, "b", "Write", {}),
    ];
    expect(interruptedCompletionInputs(calls)).toEqual([
      {
        call: calls[0],
        kind: "synthetic",
        reason: "interrupted_active",
      },
      {
        call: calls[1],
        kind: "synthetic",
        reason: "skipped_after_interruption",
      },
    ]);
  });
});

function createLedgerFixture(prefix: string) {
  const idFactory = deterministicIdFactory(prefix);
  const sessionId = idFactory.createSessionId();
  const turn: TurnIdentity = {
    sessionId,
    turnId: idFactory.createTurnId(),
    turnNumber: 1,
  };
  const iteration: IterationIdentity = {
    ...turn,
    iterationId: idFactory.createIterationId(),
    iterationNumber: 1,
  };
  return {
    idFactory,
    turn,
    iteration,
    ledger: new InMemorySessionLedger({
      sessionId,
      systemPrompt: "system",
      idFactory,
    }),
    iterationIdentity(iterationNumber: number): IterationIdentity {
      return {
        ...turn,
        iterationId: idFactory.createIterationId(),
        iterationNumber,
      };
    },
    toolCall(
      inputIteration: IterationIdentity,
      toolCallNumber: number,
      providerToolCallId: string,
      name: string,
      args: unknown,
    ): ToolCall {
      return {
        ...inputIteration,
        toolCallId: idFactory.createToolCallId(),
        toolCallNumber,
        providerToolCallId,
        name,
        args,
      };
    },
  };
}
