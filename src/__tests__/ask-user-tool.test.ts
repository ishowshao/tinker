import { describe, expect, test } from "bun:test";
import { TurnCancelledError } from "../agent/turn-cancellation";
import { ObservationBuilder } from "../observation/observation-builder";
import { createAskUserToolExecutor } from "../tools/ask-user";
import { createTestRuntime } from "./test-runtime";

const runtime = createTestRuntime();
const call = runtime.toolCall({
  providerToolCallId: "ask-user-1",
  name: "AskUser",
  args: {},
});

describe("AskUser tool", () => {
  test("publishes the intended schema and returns a selected answer", async () => {
    const executor = createAskUserToolExecutor();
    expect(executor.definition.name).toBe("AskUser");
    expect(executor.definition.parameters).not.toHaveProperty("additionalProperties");
    let request: unknown;
    const raw = await executor.execute(
      {
        question: "Which scope?",
        options: [
          { description: "Current project", extra: true },
          { description: "All projects" },
        ],
        ignored: true,
      },
      call,
      {
        signal: new AbortController().signal,
        askUser: async (value) => {
          request = value;
          return { outcome: "selected", answer: value.options[1].description };
        },
      },
    );
    expect(request).toEqual({
      question: "Which scope?",
      options: [{ description: "Current project" }, { description: "All projects" }],
    });
    expect(raw).toEqual({
      kind: "ask_user",
      ok: true,
      outcome: "selected",
      answer: "All projects",
    });
    expect(new ObservationBuilder().build({ call, raw }).displayText).toBe(
      "User selected: All projects",
    );
  });

  test("returns a successful dismissed result", async () => {
    const raw = await createAskUserToolExecutor().execute(
      {
        question: "Which scope?",
        options: [{ description: "One" }, { description: "Two" }],
      },
      call,
      {
        signal: new AbortController().signal,
        askUser: async () => ({ outcome: "dismissed" }),
      },
    );
    expect(raw).toEqual({ kind: "ask_user", ok: true, outcome: "dismissed" });
    expect(new ObservationBuilder().build({ call, raw }).displayText).toBe(
      "The user did not select an option. Decide how to proceed.",
    );
  });

  test("rejects malformed options and unavailable interaction", async () => {
    const executor = createAskUserToolExecutor();
    const signal = new AbortController().signal;
    expect(
      await executor.execute(
        { question: "Q", options: [{ description: "Only" }] },
        call,
        { signal },
      ),
    ).toMatchObject({ kind: "ask_user", ok: false });
    expect(
      await executor.execute(
        {
          question: "Q",
          options: [{ description: "One" }, { description: 2 }],
        },
        call,
        { signal },
      ),
    ).toMatchObject({ kind: "ask_user", ok: false });
    expect(
      await executor.execute(
        {
          question: "Q",
          options: [{ description: "One" }, { description: "Two" }],
        },
        call,
        { signal },
      ),
    ).toEqual({
      kind: "ask_user",
      ok: false,
      error: "AskUser interaction is unavailable.",
    });
  });

  test("propagates turn cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new TurnCancelledError("user"));
    expect(() =>
      createAskUserToolExecutor().execute(
        {
          question: "Q",
          options: [{ description: "One" }, { description: "Two" }],
        },
        call,
        { signal: controller.signal, askUser: async () => ({ outcome: "dismissed" }) },
      ),
    ).toThrow(TurnCancelledError);
  });
});
