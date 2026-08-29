import { describe, expect, test } from "bun:test";
import { TurnCancelledError } from "../agent/turn-cancellation";
import { ObservationBuilder } from "../observation/observation-builder";
import { decodeStoredToolRawResult } from "../session/session-store";
import { createWaitToolExecutor } from "../tools/wait";
import { createTestRuntime } from "./test-runtime";

const executionContext = { signal: new AbortController().signal };

describe("Wait tool", () => {
  test("waits the requested seconds and reports elapsed time", async () => {
    const executor = createWaitToolExecutor();
    const call = createTestRuntime().toolCall({
      name: "Wait",
      args: { seconds: 1 },
    });

    const startedAt = Date.now();
    const raw = await executor.execute(call.args, call, executionContext);

    expect(raw).toMatchObject({ kind: "wait", ok: true, seconds: 1 });
    if (raw.kind === "wait" && raw.ok) {
      expect(raw.waitedMs).toBeGreaterThanOrEqual(900);
      expect(raw.waitedMs).toBeLessThan(10_000);
    }
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);

    const observation = new ObservationBuilder().build({ call, raw }).displayText;
    expect(observation).toBe("Waited 1 second.");
    expect(decodeStoredToolRawResult(raw)).toEqual(raw);
  });

  test("rejects invalid seconds values", async () => {
    const executor = createWaitToolExecutor();
    const runtime = createTestRuntime();

    for (const [args, error] of [
      [{}, "Wait seconds must be an integer."],
      [{ seconds: 0.5 }, "Wait seconds must be an integer."],
      [{ seconds: "5" }, "Wait seconds must be an integer."],
      [{ seconds: 0 }, "Wait seconds must be between 1 and 3600."],
      [{ seconds: 3601 }, "Wait seconds must be between 1 and 3600."],
      [{ seconds: 5, extra: true }, "Wait received unexpected argument: extra."],
    ] as const) {
      const call = runtime.toolCall({ name: "Wait", args });
      const raw = await executor.execute(call.args, call, executionContext);
      expect(raw).toEqual({ kind: "wait", ok: false, error });
    }
  });

  test("stops waiting when the turn is cancelled", async () => {
    const executor = createWaitToolExecutor();
    const call = createTestRuntime().toolCall({
      name: "Wait",
      args: { seconds: 3600 },
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new TurnCancelledError("user")), 50);

    const startedAt = Date.now();
    let error: unknown;
    try {
      await executor.execute(call.args, call, { signal: controller.signal });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TurnCancelledError);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});
