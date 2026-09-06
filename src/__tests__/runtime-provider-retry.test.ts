import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRuntimeSession } from "../agent/runtime-session";
import { RuntimeProviderRetry } from "../agent/runtime-provider-retry";
import { TurnCancelledError } from "../agent/turn-cancellation";
import {
  ProviderResponseError,
  type ModelRequestOptions,
  type ModelRequestOutput,
  type PreparedModelRequest,
} from "../model/model-client";
import { resolveSessionDatabasePath } from "../session/session-store";
import { createInput } from "./helpers/runtime-session-support";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";
import {
  collectingEventSink,
  createTestRuntime,
  deterministicIdFactory,
  TestModelClient,
  testModelOutput,
  testModelRequestInput,
} from "./test-runtime";

isolateTinkerHome();
const providerFailure = () =>
  new ProviderResponseError(
    "reasoning_only_assistant",
    "provider produced no valid answer",
    { provider: "test", model: "test-model" },
  );
class RetryModel extends TestModelClient {
  readonly requests: PreparedModelRequest[] = [];
  readonly identities: ModelRequestOptions["identity"][] = [];
  constructor(private readonly steps: readonly ("read" | "done" | Error)[]) {
    super();
  }
  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.requests.push(prepared);
    this.identities.push(options.identity);
    const step = this.steps[this.requests.length - 1];
    if (step instanceof Error) throw step;
    if (step === "read") {
      const identity = options.identity!;
      return testModelOutput(prepared, {
        role: "assistant",
        toolCalls: [
          {
            ...identity.runtimeSession.createToolCall(identity.iteration, 1),
            providerToolCallId: "read-seed",
            name: "Read",
            args: { file_path: "seed.txt" },
          },
        ],
      });
    }
    if (step !== "done") throw new Error("Unexpected request");
    return testModelOutput(prepared, { role: "assistant", content: "retry completed" });
  }
}

async function fixture(steps: readonly ("read" | "done" | Error)[], enabled = true) {
  const model = new RetryModel(steps);
  const sink = collectingEventSink();
  const input = {
    ...createInput(model, sink, "provider-retry"),
    enableProviderRetryPrompt: enabled,
  };
  await writeFile(path.join(input.workspaceRoot, "seed.txt"), "seed content");
  const session = await createRuntimeSession(input, {
    idFactory: deterministicIdFactory("provider-retry"),
    loadMcpConfig: async () => undefined,
  });
  const database = new Database(
    await resolveSessionDatabasePath(input.workspaceRoot, session.sessionId),
    { readonly: true },
  );
  const controller = new AbortController();
  return {
    model,
    sink,
    session,
    database,
    controller,
    run: () =>
      session.executeTurn({
        userMessage: { role: "user", content: "inspect seed" },
        signal: controller.signal,
      }),
    async waiting(afterAttempt = 0) {
      await waitUntil(
        () =>
          (session.providerRetry().pending?.failure.attemptNumber ?? 0) > afterAttempt,
      );
      return session.providerRetry().pending!;
    },
    async close() {
      await session.dispose({ type: "tui_exit" });
      database.close();
      await rm(input.workspaceRoot, { recursive: true });
    },
  };
}

describe("provider retry selection", () => {
  test("retries the same request and iteration across multiple decisions without changing canonical history", async () => {
    const f = await fixture([
      "read",
      providerFailure(),
      providerFailure(),
      providerFailure(),
      providerFailure(),
      "done",
    ]);
    try {
      const completion = f.run();
      const first = await f.waiting();
      const history = f.database.query("SELECT * FROM messages ORDER BY ordinal").all();
      expect(history).toHaveLength(4);
      expect(f.database.query("SELECT status FROM turns").all()).toEqual([
        { status: "open" },
      ]);
      expect(
        f.database
          .query(
            "SELECT iteration_number, outcome FROM iterations ORDER BY iteration_number",
          )
          .all(),
      ).toEqual([
        { iteration_number: 1, outcome: "continue" },
        { iteration_number: 2, outcome: "open" },
      ]);
      expect(f.session.promptScheduler().state).toBe("running");
      expect(f.sink.events.some((event) => event.type === "turn.failed")).toBe(false);
      await f.session.resolveProviderRetry(first.requestId, "retry");
      const second = await f.waiting(first.failure.attemptNumber);
      expect(f.database.query("SELECT * FROM messages ORDER BY ordinal").all()).toEqual(
        history,
      );
      expect(f.session.resolveProviderRetry(first.requestId, "retry")).rejects.toThrow(
        "no longer pending",
      );
      await f.session.resolveProviderRetry(second.requestId, "retry");
      expect(await completion).toMatchObject({
        status: "completed",
        finalText: "retry completed",
        lastIteration: { iterationNumber: 2 },
      });
      expect(
        f.model.requests.slice(1).every((request) => request === f.model.requests[1]),
      ).toBe(true);
      expect(
        f.model.identities
          .slice(1)
          .every(
            (identity) =>
              identity?.iteration.iterationId ===
              f.model.identities[1]?.iteration.iterationId,
          ),
      ).toBe(true);
      expect(testModelRequestInput(f.model.requests[1]).messages.at(-1)?.role).toBe(
        "tool",
      );
      expect(
        f.database.query("SELECT role FROM messages ORDER BY ordinal").all(),
      ).toEqual([
        { role: "system" },
        { role: "user" },
        { role: "assistant" },
        { role: "tool" },
        { role: "assistant" },
      ]);
      expect(
        f.sink.events.filter((event) => event.type === "agent.iteration.started"),
      ).toHaveLength(2);
      expect(
        f.sink.events.filter((event) => event.type === "tool.started"),
      ).toHaveLength(1);
      expect(
        f.sink.events
          .filter((event) => event.type === "model.request.started")
          .filter((event) => event.iterationNumber === 2)
          .map((event) => event.data.attemptNumber),
      ).toEqual([1, 2, 3, 4, 5]);
      expect(
        f.sink.events
          .filter((event) => event.type === "model.retry.resolved")
          .map((event) => event.data.decision),
      ).toEqual(["retry", "retry"]);
      expect(f.session.providerRetry().pending).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  test("stopping preserves the original failure and allows the next turn", async () => {
    const f = await fixture([providerFailure(), providerFailure(), "done"]);
    try {
      const completion = f.run();
      const pending = await f.waiting();
      await f.session.resolveProviderRetry(pending.requestId, "stop");
      const result = await completion;
      expect(result.status).toBe("failed");
      expect(result.status === "failed" ? result.error : "").toContain(
        "Provider returned reasoning",
      );
      expect(f.database.query("SELECT status FROM turns").all()).toEqual([
        { status: "failed" },
      ]);
      expect(f.model.requests).toHaveLength(2);
      expect(await f.run()).toMatchObject({ status: "completed" });
      expect(
        f.sink.events.filter((event) => event.type === "turn.started"),
      ).toHaveLength(2);
    } finally {
      await f.close();
    }
  });

  for (const action of ["abort", "dispose"] as const) {
    test(`settles a pending retry on ${action}`, async () => {
      const f = await fixture([providerFailure(), providerFailure()]);
      try {
        const completion = f.run();
        await f.waiting();
        if (action === "abort") f.controller.abort(new TurnCancelledError("user"));
        else await f.session.dispose({ type: "tui_exit" });
        expect(await completion).toMatchObject({ status: "cancelled" });
        expect(f.session.providerRetry().pending).toBeUndefined();
        expect(f.model.requests).toHaveLength(2);
        expect(
          f.sink.events
            .filter((event) => event.type === "model.retry.resolved")
            .map((event) => event.data.decision),
        ).toEqual(["cancelled"]);
      } finally {
        await f.close();
      }
    });
  }

  test("does not wait without an interactive consumer", async () => {
    const f = await fixture([providerFailure(), providerFailure()], false);
    try {
      expect(await f.run()).toMatchObject({ status: "failed" });
      expect(
        f.sink.events.some((event) => event.type === "model.retry.requested"),
      ).toBe(false);
    } finally {
      await f.close();
    }
  });

  test("does not offer retries for non-retryable errors", async () => {
    const f = await fixture([
      new ProviderResponseError("invalid_provider_response", "malformed response", {
        provider: "test",
        model: "test-model",
      }),
    ]);
    try {
      expect(await f.run()).toMatchObject({
        status: "failed",
        error: "malformed response",
      });
      expect(f.session.providerRetry().pending).toBeUndefined();
      expect(
        f.sink.events.some((event) => event.type === "model.retry.requested"),
      ).toBe(false);
    } finally {
      await f.close();
    }
  });

  test("cancellation while publishing the question records a resolution and never waits", async () => {
    const controller = new AbortController();
    const decisions: string[] = [];
    const retry = new RuntimeProviderRetry(async (event) => {
      if (event.type === "model.retry.requested")
        controller.abort(new TurnCancelledError("user"));
      if (event.type === "model.retry.resolved" && "decision" in event.data) {
        decisions.push(event.data.decision);
      }
    });
    const outcome = await retry
      .request(
        createTestRuntime().iteration,
        {
          attemptNumber: 2,
          maxAttempts: 6,
          code: "provider_unavailable",
          retryDisposition: "exhausted",
          provider: "test",
          model: "test-model",
          error: "unavailable",
        },
        controller.signal,
      )
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(TurnCancelledError);
    expect(decisions).toEqual(["cancelled"]);
    expect(retry.read().pending).toBeUndefined();
  });

  test("rejects both the answer and waiting loop if decision logging fails", async () => {
    const retry = new RuntimeProviderRetry(async (event) => {
      if (event.type === "model.retry.resolved")
        throw new Error("event storage failed");
    });
    const waiting = retry.request(
      createTestRuntime().iteration,
      {
        attemptNumber: 2,
        maxAttempts: 6,
        code: "provider_unavailable",
        retryDisposition: "exhausted",
        provider: "test",
        model: "test-model",
        error: "unavailable",
      },
      new AbortController().signal,
    );
    const rejection = waiting.catch((error: unknown) => error);
    await waitUntil(() => retry.read().pending !== undefined);
    expect(retry.resolve(retry.read().pending!.requestId, "retry")).rejects.toThrow(
      "event storage failed",
    );
    expect(await rejection).toMatchObject({ message: "event storage failed" });
    expect(retry.read().pending).toBeUndefined();
  });
});

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error("Retry interaction did not become ready");
    await Bun.sleep(1);
  }
}
