import { describe, expect, test } from "bun:test";
import { CompositeEventSink } from "../events/composite-event-sink";
import type { EventSink } from "../events/event-sink";
import { collectingEventSink, createTestRuntime } from "./test-runtime";

describe("CompositeEventSink", () => {
  test("delivers to remaining sinks before surfacing a required sink failure", async () => {
    const auxiliary = collectingEventSink();
    const requiredFailure: EventSink = {
      name: "required-test-log",
      async append() {
        throw new Error("disk unavailable");
      },
    };
    const composite = new CompositeEventSink({
      requiredSinks: [requiredFailure],
      auxiliarySinks: [auxiliary],
    });
    const runtime = createTestRuntime(composite);

    const error = await runtime.runtimeSession
      .append({
        type: "agent.iteration.started",
        ...runtime.iteration,
        data: { iterationNumber: 1 },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "Required event sink required-test-log failed while appending agent.iteration.started",
    );
    expect(auxiliary.events.map((event) => event.type)).toEqual([
      "agent.iteration.started",
    ]);
  });
});
