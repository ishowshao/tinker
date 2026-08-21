import { describe, expect, test } from "bun:test";
import { InMemorySessionLedger } from "../agent/session-ledger";
import type { IterationIdentity, ToolCall, TurnIdentity } from "../agent/types";
import { textToolResultContent } from "../agent/tool-result-content";
import {
  ContextProtocolError,
  ContextProtocolValidator,
} from "../context/context-protocol-validator";
import type { ProtocolContextView } from "../context/protocol-frame";
import { deterministicIdFactory } from "./test-runtime";

describe("ContextProtocolValidator", () => {
  test("accepts a complete multi-tool exchange", () => {
    const view = completeToolView();
    expect(() =>
      new ContextProtocolValidator().validate(view, { fullIntegrity: true }),
    ).not.toThrow();
  });

  test("rejects missing, reordered, and mismatched tool records precisely", () => {
    const validator = new ContextProtocolValidator();
    const valid = completeToolView();
    const toolFrame = valid.frames.at(-1)!;

    const missingMessage = cloneView(valid);
    missingMessage.messages.splice(-1, 1);
    missingMessage.toolResults.splice(-1, 1);
    missingMessage.frames[missingMessage.frames.length - 1] = {
      ...toolFrame,
      lastOrdinal: missingMessage.messages.length,
    };
    expectProtocolCode(
      () => validator.validate(missingMessage),
      "missing_tool_message",
    );

    const reordered = cloneView(valid);
    const firstToolIndex = reordered.messages.length - 2;
    [reordered.messages[firstToolIndex], reordered.messages[firstToolIndex + 1]] = [
      reordered.messages[firstToolIndex + 1],
      reordered.messages[firstToolIndex],
    ];
    reordered.messages[firstToolIndex] = {
      ...reordered.messages[firstToolIndex],
      ordinal: firstToolIndex + 1,
    };
    reordered.messages[firstToolIndex + 1] = {
      ...reordered.messages[firstToolIndex + 1],
      ordinal: firstToolIndex + 2,
    };
    expectProtocolCode(
      () => validator.validate(reordered),
      "tool_message_order_mismatch",
    );

    const missingResult = cloneView(valid);
    missingResult.toolResults.splice(0, 1);
    expectProtocolCode(() => validator.validate(missingResult), "missing_tool_result");
  });

  test("rejects duplicate provider IDs and hash corruption", () => {
    const validator = new ContextProtocolValidator();
    const duplicateProvider = cloneView(completeToolView());
    const assistantIndex = duplicateProvider.messages.findIndex(
      (message) => message.role === "assistant",
    );
    const assistant = duplicateProvider.messages[assistantIndex];
    if (assistant.role !== "assistant" || assistant.toolCalls === undefined) {
      throw new Error("Expected assistant tool calls.");
    }
    duplicateProvider.messages[assistantIndex] = {
      ...assistant,
      toolCalls: [
        assistant.toolCalls[0],
        {
          ...assistant.toolCalls[1],
          providerToolCallId: assistant.toolCalls[0].providerToolCallId,
        },
      ],
    };
    expectProtocolCode(
      () => validator.validate(duplicateProvider),
      "duplicate_provider_tool_call_id",
    );

    const contentCorruption = cloneView(completeToolView());
    const user = contentCorruption.messages[1];
    if (user.role !== "user") {
      throw new Error("Expected user message.");
    }
    contentCorruption.messages[1] = {
      ...user,
      content: "tampered",
    };
    expectProtocolCode(
      () =>
        validator.validate(contentCorruption, {
          fullIntegrity: true,
        }),
      "content_hash_mismatch",
    );

    const rawCorruption = cloneView(completeToolView());
    const returned = rawCorruption.toolResults.find(
      (result) => result.completion.kind === "returned",
    );
    if (returned?.completion.kind !== "returned") {
      throw new Error("Expected returned tool result.");
    }
    if (returned.completion.raw.kind !== "read") {
      throw new Error("Expected returned Read result.");
    }
    rawCorruption.toolResults[0] = {
      ...returned,
      completion: {
        ...returned.completion,
        raw: { ...returned.completion.raw, ok: false },
      },
    };
    expectProtocolCode(
      () => validator.validate(rawCorruption, { fullIntegrity: true }),
      "raw_hash_mismatch",
    );
  });

  test("allows a valid open tail only for recovery validation", () => {
    const fixture = ledgerFixture("open-tail");
    const pending = fixture.ledger.beginTurn({
      turn: fixture.turn,
      userMessage: { role: "user", content: "run" },
    });
    const call = fixture.call(1, "provider-call", "Read");
    pending.agent.appendAssistant({
      iteration: fixture.iteration,
      message: { role: "assistant", toolCalls: [call] },
      provider: "test",
      model: "test-model",
    });
    const view = fixture.ledger.snapshot({ allowOpenTail: true });
    const validator = new ContextProtocolValidator();
    expectProtocolCode(() => validator.validate(view), "open_frame");
    expect(() =>
      validator.validate(view, { allowOpenTail: true, fullIntegrity: true }),
    ).not.toThrow();
  });
});

function completeToolView(): ProtocolContextView {
  const fixture = ledgerFixture("validator");
  const pending = fixture.ledger.beginTurn({
    turn: fixture.turn,
    userMessage: { role: "user", content: "run" },
  });
  const first = fixture.call(1, "provider-first", "Read");
  const second = fixture.call(2, "provider-second", "Glob");
  pending.agent.appendAssistant({
    iteration: fixture.iteration,
    message: { role: "assistant", content: "progress", toolCalls: [first, second] },
    provider: "test",
    model: "test-model",
  });
  pending.agent.commitToolCompletions([
    {
      call: first,
      kind: "returned",
      raw: {
        kind: "read",
        ok: true,
        filePath: "README.md",
        content: "hello",
      },
      observation: textToolResultContent("Read succeeded."),
    },
    {
      call: second,
      kind: "synthetic",
      reason: "skipped_after_cancel",
    },
  ]);
  return fixture.ledger.snapshot({ fullIntegrity: true });
}

function ledgerFixture(prefix: string) {
  const ids = deterministicIdFactory(prefix);
  const sessionId = ids.createSessionId();
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
  return {
    ledger: new InMemorySessionLedger({
      sessionId,
      systemPrompt: "system",
      idFactory: ids,
    }),
    turn,
    iteration,
    call(toolCallNumber: number, providerToolCallId: string, name: string): ToolCall {
      return {
        ...iteration,
        toolCallId: ids.createToolCallId(),
        toolCallNumber,
        providerToolCallId,
        name,
        args: {},
      };
    },
  };
}

function cloneView(view: ProtocolContextView): {
  sessionId: ProtocolContextView["sessionId"];
  faulted: boolean;
  frames: Array<ProtocolContextView["frames"][number]>;
  messages: Array<ProtocolContextView["messages"][number]>;
  toolResults: Array<ProtocolContextView["toolResults"][number]>;
} {
  return structuredClone(view) as unknown as {
    sessionId: ProtocolContextView["sessionId"];
    faulted: boolean;
    frames: Array<ProtocolContextView["frames"][number]>;
    messages: Array<ProtocolContextView["messages"][number]>;
    toolResults: Array<ProtocolContextView["toolResults"][number]>;
  };
}

function expectProtocolCode(
  operation: () => void,
  code: ContextProtocolError["code"],
): void {
  try {
    operation();
    throw new Error(`Expected protocol error ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(ContextProtocolError);
    expect((error as ContextProtocolError).code).toBe(code);
  }
}
