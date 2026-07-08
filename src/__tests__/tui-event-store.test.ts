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
    expect(state.timeline.at(-1)?.label).toBe("assistant");
    expect(state.timeline.at(-1)?.text).toBe("done");
    expect(state.timeline.at(-1)?.status).toBe("text");

    state = applyAgentEvent(state, {
      type: "run.failed",
      error: "failed",
    });
    expect(state.status).toBe("failed");
    expect(state.error).toBe("failed");
    expect(state.timeline.at(-1)?.label).toBe("error");
    expect(state.timeline.at(-1)?.text).toBe("failed");
  });

  test("starts a new prompt while preserving previous final answers", () => {
    let state = createInitialTuiState({
      runId: "run-1",
      modelName: "model",
      workspaceRoot: "/tmp/workspace",
    });

    state = applyAgentEvent(state, {
      type: "run.started",
      runId: "run-1",
      createdAt: "2026-07-06T00:00:00.000Z",
      input: { userPrompt: "first" },
    });
    state = applyAgentEvent(state, {
      type: "run.finished",
      result: { ok: true, finalText: "first done", messages: [] },
    });
    state = applyAgentEvent(state, {
      type: "run.started",
      runId: "run-1",
      createdAt: "2026-07-06T00:01:00.000Z",
      input: { userPrompt: "second" },
    });

    expect(state.status).toBe("running");
    expect(state.timeline.map((item) => item.text)).toEqual([
      "first",
      "first done",
      "second",
    ]);
    expect(state.timeline.map((item) => item.label)).toEqual([
      "prompt",
      "assistant",
      "prompt",
    ]);
    expect(new Set(state.timeline.map((item) => item.id)).size).toBe(3);
  });

  test("updates model and tool timeline items with useful summaries", () => {
    let state = createInitialTuiState({
      runId: "run-1",
      modelName: "model",
      workspaceRoot: "/tmp/workspace",
    });

    state = applyAgentEvent(state, {
      type: "model.step.started",
      step: 1,
    });
    state = applyAgentEvent(state, {
      type: "model.step.finished",
      step: 1,
      output: {
        message: {
          role: "assistant",
          toolCalls: [
            { id: "call_1", name: "Glob", args: { pattern: "**/*.test.ts" } },
            { id: "call_2", name: "Glob", args: { pattern: "**/*.test.tsx" } },
          ],
        },
      },
    });

    expect(state.timeline).toHaveLength(1);
    expect(state.timeline[0]?.text).toBe("model step 1 -> 2 tool calls");
    expect(state.timeline[0]?.status).toBe("ok");

    state = applyAgentEvent(state, {
      type: "assistant.progress",
      step: 1,
      content: "I will inspect the matching tests.",
    });
    expect(state.timeline).toHaveLength(2);
    expect(state.timeline[1]).toMatchObject({
      label: "assistant",
      text: "I will inspect the matching tests.",
      status: "text",
    });

    state = applyAgentEvent(state, {
      type: "tool.started",
      step: 1,
      call: { id: "call_1", name: "Glob", args: { pattern: "**/*.test.ts" } },
    });
    state = applyAgentEvent(state, {
      type: "tool.raw_result",
      step: 1,
      call: { id: "call_1", name: "Glob", args: { pattern: "**/*.test.ts" } },
      raw: { ok: true, pattern: "**/*.test.ts", matchCount: 5, matches: [] },
    });
    state = applyAgentEvent(state, {
      type: "tool.finished",
      step: 1,
      call: { id: "call_1", name: "Glob", args: { pattern: "**/*.test.ts" } },
      ok: true,
    });

    expect(state.timeline).toHaveLength(3);
    expect(state.timeline[2]?.text).toBe("Glob **/*.test.ts -> 5 matches");
    expect(state.timeline[2]?.status).toBe("ok");
  });
});
