import { describe, expect, test } from "bun:test";
import {
  canonicalToolResultContentHash,
  textToolResultContent,
  toolResultDisplayText,
} from "../agent/tool-result-content";
import type { ToolCall } from "../agent/types";
import { renderContextSwapCandidateLabel } from "../context/context-swap-label";
import { isSwappableRawResult } from "../context/context-swap-renderer";
import {
  contentHash,
  CURRENT_TOOL_OBSERVATION_FORMAT,
  rawResultHash,
  type ProtocolContextView,
  type ToolResultRecord,
} from "../context/protocol-frame";
import { ObservationBuilder } from "../observation/observation-builder";
import { runtimeIdFactory } from "../ids/runtime-id";
import { decodeStoredToolRawResult } from "../session/session-store";
import {
  CONTEXT_MAINTENANCE_TOOL_DEFINITIONS,
  createContextStatusToolExecutor,
  createContextSwapCandidatesToolExecutor,
  createContextSwapToolExecutor,
} from "../tools/context-maintenance";
import { ToolRegistry, ToolRuntime } from "../tools/registry";
import {
  ToolExecutionFatalError,
  type ContextMaintenanceHandle,
  type ToolRawResult,
} from "../tools/types";
import { createTestRuntime } from "./test-runtime";

describe("context maintenance tools", () => {
  test("publishes three constant strict schemas", () => {
    expect(CONTEXT_MAINTENANCE_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      "ContextStatus",
      "ContextSwapCandidates",
      "ContextSwap",
    ]);
    for (const definition of CONTEXT_MAINTENANCE_TOOL_DEFINITIONS) {
      expect(definition.parameters).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }
    expect(CONTEXT_MAINTENANCE_TOOL_DEFINITIONS[2]?.parameters).toMatchObject({
      required: ["candidate_ids"],
      properties: {
        candidate_ids: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          uniqueItems: true,
        },
      },
    });
  });

  test("validates arguments, applies paging defaults, and deduplicates swap IDs", async () => {
    const firstId = runtimeIdFactory.createMessageId();
    const secondId = runtimeIdFactory.createMessageId();
    const pages: Array<{ limit: number; offset: number }> = [];
    const selections: string[][] = [];
    const handle: ContextMaintenanceHandle = {
      async status() {
        return {
          ok: true,
          operation: "status",
          usedInputTokens: 42,
          inputBudgetTokens: 100,
          pressure: "normal",
          triggerTokens: 80,
          source: "estimated_full",
        };
      },
      async candidates(_call, page) {
        pages.push({ ...page });
        return {
          ok: true,
          operation: "candidates",
          total: 1,
          candidates: [
            {
              candidateId: firstId,
              label: "Read: src/agent/loop.ts:1-20",
              ordinal: 4,
              savingsBytes: 12_000,
            },
          ],
        };
      },
      async swap(_call, selection) {
        selections.push([...selection.candidateIds]);
        return {
          ok: true,
          operation: "swap",
          scheduled: selection.candidateIds.map((candidateId) => ({
            candidateId,
            savingsBytes: 12_000,
          })),
          rejected: [],
          note: "Swap executes when this iteration's tool frames close.",
        };
      },
    };
    const registry = contextRegistry();
    const runtime = new ToolRuntime(registry, undefined, handle);
    const harness = createTestRuntime();
    const signal = new AbortController().signal;

    expect(
      await runtime.execute(harness.toolCall({ name: "ContextStatus", args: {} }), {
        signal,
      }),
    ).toMatchObject({
      kind: "context_maintenance",
      ok: true,
      operation: "status",
    });
    expect(
      await runtime.execute(
        harness.toolCall({ name: "ContextSwapCandidates", args: {} }),
        { signal },
      ),
    ).toMatchObject({
      kind: "context_maintenance",
      ok: true,
      operation: "candidates",
      total: 1,
    });
    expect(pages).toEqual([{ limit: 20, offset: 0 }]);

    const swap = await runtime.execute(
      harness.toolCall({
        name: "ContextSwap",
        args: { candidate_ids: [firstId, firstId, secondId] },
      }),
      { signal },
    );
    expect(swap).toMatchObject({
      kind: "context_maintenance",
      ok: true,
      operation: "swap",
    });
    expect(selections).toEqual([[firstId, secondId]]);

    expect(
      await runtime.execute(
        harness.toolCall({
          name: "ContextSwapCandidates",
          args: { limit: 51, offset: 0 },
        }),
        { signal },
      ),
    ).toMatchObject({
      kind: "context_maintenance",
      ok: false,
      operation: "candidates",
    });
    expect(
      await runtime.execute(
        harness.toolCall({
          name: "ContextSwap",
          args: { candidate_ids: ["not-a-message-id"] },
        }),
        { signal },
      ),
    ).toMatchObject({
      kind: "context_maintenance",
      ok: false,
      operation: "swap",
      scheduled: [],
      rejected: [],
    });
    expect(pages).toHaveLength(1);
    expect(selections).toHaveLength(1);
  });

  test("requires an active runtime coordinator", () => {
    const harness = createTestRuntime();
    const runtime = new ToolRuntime(contextRegistry());
    expect(
      runtime.execute(harness.toolCall({ name: "ContextStatus", args: {} }), {
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ToolExecutionFatalError);
  });

  test("renders compact model observations without the persistence discriminator", () => {
    const raw: ToolRawResult = {
      kind: "context_maintenance",
      ok: true,
      operation: "candidates",
      total: 1,
      candidates: [
        {
          candidateId: runtimeIdFactory.createMessageId(),
          label: "Bash: bun run check:fast",
          ordinal: 8,
          savingsBytes: 9_000,
        },
      ],
    };
    const harness = createTestRuntime();
    const observation = new ObservationBuilder().build({
      call: harness.toolCall({ name: "ContextSwapCandidates", args: {} }),
      raw,
    });
    const rendered = JSON.parse(toolResultDisplayText(observation.content)) as Record<
      string,
      unknown
    >;
    expect(rendered).toEqual({
      ok: true,
      total: 1,
      candidates: raw.candidates,
    });
    expect(rendered).not.toHaveProperty("operation");
    expect(isSwappableRawResult(raw)).toBe(false);
  });

  test("renders argument-anchored single-line labels within 80 UTF-8 bytes", () => {
    const sessionId = runtimeIdFactory.createSessionId();
    expect(
      candidateLabel(
        "Bash",
        { command: "bun run check", description: "Run\nquality\tgate" },
        {
          kind: "bash",
          ok: true,
          command: "bun run check",
          taskId: "task-1",
          sessionId,
          status: "completed",
          cwd: "/workspace",
          outputFilePath: "task.log",
          outputBytes: 0,
          outputLines: 0,
          preview: "",
          truncated: false,
          tty: false,
        },
      ),
    ).toBe("Bash: Run quality gate");
    expect(
      candidateLabel(
        "Read",
        { file_path: "src/agent/loop.ts", offset: 330, limit: 230 },
        { kind: "read", ok: true, filePath: "src/agent/loop.ts" },
      ),
    ).toBe("Read: src/agent/loop.ts:330-559");
    expect(
      candidateLabel(
        "Grep",
        { pattern: "maintainContext", path: "src/agent" },
        {
          kind: "grep",
          ok: true,
          pattern: "maintainContext",
          searchPath: "src/agent",
          mode: "content",
          filenames: [],
          numFiles: 0,
        },
      ),
    ).toBe('Grep: "maintainContext" in src/agent');
    expect(
      candidateLabel(
        "WebFetch",
        { url: "https://docs.example.com/context" },
        {
          kind: "web_fetch",
          ok: true,
          url: "https://docs.example.com/context",
        },
      ),
    ).toBe("WebFetch: docs.example.com/context");
    expect(
      candidateLabel(
        "mcp__playwright__browser_click",
        {},
        {
          kind: "mcp",
          ok: true,
          toolName: "mcp__playwright__browser_click",
          serverName: "playwright",
          serverToolName: "browser_click",
        },
      ),
    ).toBe("MCP: playwright.browser_click");

    const truncated = candidateLabel(
      "Glob",
      { pattern: `src/${"界".repeat(50)}` },
      { kind: "glob", ok: true, pattern: "ignored", searchPath: "." },
    );
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(80);
    expect(truncated.endsWith("…")).toBe(true);
    expect(truncated).not.toContain("�");
  });

  test("strictly decodes every persisted context-maintenance result shape", () => {
    const candidateId = runtimeIdFactory.createMessageId();
    const values: ToolRawResult[] = [
      {
        kind: "context_maintenance",
        ok: true,
        operation: "status",
        usedInputTokens: 81,
        inputBudgetTokens: 100,
        pressure: "high",
        triggerTokens: 80,
        source: "measured_plus_estimated_delta",
      },
      {
        kind: "context_maintenance",
        ok: true,
        operation: "candidates",
        total: 1,
        candidates: [
          {
            candidateId,
            label: "Read: large.txt",
            ordinal: 4,
            savingsBytes: 20_000,
          },
        ],
      },
      {
        kind: "context_maintenance",
        ok: true,
        operation: "swap",
        scheduled: [{ candidateId, savingsBytes: 20_000 }],
        rejected: [],
        note: "Swap executes when this iteration's tool frames close.",
      },
      {
        kind: "context_maintenance",
        ok: false,
        operation: "swap",
        scheduled: [],
        rejected: [{ candidateId, reason: "already_swapped" }],
      },
    ];
    for (const value of values) {
      expect(decodeStoredToolRawResult(JSON.parse(JSON.stringify(value)))).toEqual(
        value,
      );
    }

    expect(() => decodeStoredToolRawResult({ ...values[0], unexpected: true })).toThrow(
      "unknown=unexpected",
    );
    expect(() =>
      decodeStoredToolRawResult({
        ...values[1],
        candidates: [
          {
            candidateId,
            label: "界".repeat(27),
            ordinal: 4,
            savingsBytes: 20_000,
          },
        ],
      }),
    ).toThrow("invalid or too large");
  });
});

function contextRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createContextStatusToolExecutor());
  registry.register(createContextSwapCandidatesToolExecutor());
  registry.register(createContextSwapToolExecutor());
  return registry;
}

function candidateLabel(name: string, args: unknown, raw: ToolRawResult): string {
  const sessionId = runtimeIdFactory.createSessionId();
  const turnId = runtimeIdFactory.createTurnId();
  const iterationId = runtimeIdFactory.createIterationId();
  const frameId = runtimeIdFactory.createProtocolFrameId();
  const toolCallId = runtimeIdFactory.createToolCallId();
  const call: ToolCall = {
    sessionId,
    turnId,
    turnNumber: 1,
    iterationId,
    iterationNumber: 1,
    toolCallId,
    toolCallNumber: 1,
    providerToolCallId: "provider-label",
    name,
    args,
  };
  const content = textToolResultContent("observation");
  const toolMessage = {
    messageId: runtimeIdFactory.createMessageId(),
    sessionId,
    frameId,
    ordinal: 2,
    contentSha256: canonicalToolResultContentHash(content),
    createdAt: "2026-07-18T00:00:00.000Z",
    role: "tool" as const,
    turnId,
    iterationId,
    toolCallId,
    providerToolCallId: call.providerToolCallId,
    name,
    content,
    displayText: "observation",
    origin: "tool" as const,
  };
  const result: ToolResultRecord = {
    sessionId,
    frameId,
    toolCallId,
    toolMessageId: toolMessage.messageId,
    completion: {
      kind: "returned",
      raw,
      rawSha256: rawResultHash(raw),
      observationFormat: CURRENT_TOOL_OBSERVATION_FORMAT,
    },
    observationSha256: toolMessage.contentSha256,
    createdAt: toolMessage.createdAt,
  };
  const canonical: ProtocolContextView = {
    sessionId,
    faulted: false,
    frames: [],
    messages: [
      {
        messageId: runtimeIdFactory.createMessageId(),
        sessionId,
        frameId,
        ordinal: 1,
        contentSha256: contentHash(""),
        createdAt: toolMessage.createdAt,
        role: "assistant",
        turnId,
        iterationId,
        content: null,
        toolCalls: [call],
        provider: "test",
        model: "test-model",
        origin: "model",
      },
      toolMessage,
    ],
    toolResults: [result],
  };
  return renderContextSwapCandidateLabel({
    canonical,
    message: toolMessage,
    result,
  });
}
