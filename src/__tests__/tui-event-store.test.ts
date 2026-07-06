import { describe, expect, test } from "bun:test";
import { applyAgentEvent, createInitialTuiState } from "../tui/event-store";

describe("tui event store", () => {
  test("tracks run, tool, final and failure state", () => {
    let state = createInitialTuiState({
      runId: "run-1",
      modelName: "model",
      workspaceRoot: "/tmp/workspace",
    });

    state = applyAgentEvent(state, {
      type: "run.started",
      runId: "run-1",
      createdAt: "2026-07-06T00:00:00.000Z",
      input: {},
    });
    expect(state.status).toBe("running");

    state = applyAgentEvent(state, {
      type: "tool.started",
      step: 1,
      call: { id: "call_1", name: "Read", args: { file_path: "README.md" } },
    });
    state = applyAgentEvent(state, {
      type: "tool.finished",
      step: 1,
      call: { id: "call_1", name: "Read", args: { file_path: "README.md" } },
      ok: true,
    });
    expect(state.timeline.at(-1)?.text).toContain("README.md");
    expect(state.timeline.at(-1)?.status).toBe("ok");

    state = applyAgentEvent(state, {
      type: "run.finished",
      result: { ok: true, finalText: "done", messages: [] },
    });
    expect(state.status).toBe("done");
    expect(state.finalText).toBe("done");

    state = applyAgentEvent(state, {
      type: "run.failed",
      error: "failed",
    });
    expect(state.status).toBe("failed");
    expect(state.error).toBe("failed");
  });
});
