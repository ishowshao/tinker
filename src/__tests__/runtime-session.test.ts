import { describe, expect, test } from "bun:test";
import { RuntimeSession } from "../agent/runtime-session";
import type { TurnIdentity } from "../agent/types";
import type { SessionId, TurnId } from "../ids/runtime-id";
import { collectingEventSink, deterministicIdFactory } from "./test-runtime";

describe("RuntimeSession identity", () => {
  test("allocates ordered identities and session event sequences", async () => {
    const sink = collectingEventSink();
    const runtime = new RuntimeSession(sink, {
      idFactory: deterministicIdFactory("identity"),
    });
    const firstTurn = runtime.createTurn("first");
    const firstIteration = runtime.createIteration(firstTurn, 1);
    const firstCall = runtime.createToolCall(firstIteration, 1);
    const secondTurn = runtime.createTurn("second");
    const secondIteration = runtime.createIteration(secondTurn, 1);

    await runtime.append({
      type: "turn.started",
      ...firstTurn,
      data: { userPrompt: "first" },
    });
    await runtime.append({
      type: "agent.iteration.started",
      ...firstIteration,
      data: { iterationNumber: 1 },
    });
    await runtime.append({
      type: "tool.started",
      ...firstCall,
      data: {
        call: {
          ...firstCall,
          providerToolCallId: "provider-call-1",
          name: "Read",
          args: {},
        },
      },
    });

    expect(firstTurn.turnNumber).toBe(1);
    expect(secondTurn.turnNumber).toBe(2);
    expect(firstIteration.iterationNumber).toBe(1);
    expect(secondIteration.iterationNumber).toBe(1);
    expect(firstIteration.iterationId).not.toBe(secondIteration.iterationId);
    expect(sink.events.map((event) => event.eventSequence)).toEqual([1, 2, 3]);
    expect(sink.events[2]).toMatchObject({
      sessionId: runtime.sessionId,
      turnId: firstTurn.turnId,
      iterationId: firstIteration.iterationId,
      toolCallId: firstCall.toolCallId,
    });
  });

  test("fast-fails non-contiguous numbers and mismatched parents", () => {
    const runtime = new RuntimeSession(collectingEventSink(), {
      idFactory: deterministicIdFactory("invalid"),
    });
    const turn = runtime.createTurn("prompt");

    expect(() => runtime.createIteration(turn, 2)).toThrow("iterationNumber");
    const iteration = runtime.createIteration(turn, 1);
    expect(() => runtime.createToolCall(iteration, 2)).toThrow("toolCallNumber");

    const foreignTurn: TurnIdentity = {
      sessionId: "foreign-session" as SessionId,
      turnId: "foreign-turn" as TurnId,
      turnNumber: 1,
    };
    expect(() => runtime.createIteration(foreignTurn, 1)).toThrow(
      "Unknown or mismatched turn identity",
    );
  });

  test("rejects event payload identities that do not match the envelope", () => {
    const runtime = new RuntimeSession(collectingEventSink(), {
      idFactory: deterministicIdFactory("event-mismatch"),
    });
    const turn = runtime.createTurn("prompt");
    const iteration = runtime.createIteration(turn, 1);
    const firstCall = runtime.createToolCall(iteration, 1);
    const secondCall = runtime.createToolCall(iteration, 2);

    expect(() =>
      runtime.append({
        type: "tool.started",
        ...firstCall,
        data: {
          call: {
            ...secondCall,
            providerToolCallId: "provider-call-2",
            name: "Read",
            args: {},
          },
        },
      }),
    ).toThrow("data belongs to tool call");
  });

  test("production IDs are UUIDv7", () => {
    const runtime = new RuntimeSession(collectingEventSink());
    const turn = runtime.createTurn("prompt");
    const iteration = runtime.createIteration(turn, 1);
    const call = runtime.createToolCall(iteration, 1);
    const uuidV7 =
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    for (const id of [
      runtime.sessionId,
      turn.turnId,
      iteration.iterationId,
      call.toolCallId,
    ]) {
      expect(id).toMatch(uuidV7);
    }
  });
});
