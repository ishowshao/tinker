import { describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolCall } from "../agent/types";
import {
  createTestHistoryReader,
  createTestRuntime,
  type TestToolCallInput,
} from "./test-runtime";
import { ObservationBuilder } from "../observation/observation-builder";
import {
  createDefaultTooling as createDefaultToolingBase,
  ToolRegistry,
} from "../tools/registry";
import { defineToolExecutor, type ToolExecutionContext } from "../tools/types";
import { DEFAULT_PUBLIC_TOOLING_CONFIG } from "../cli/public-config-contract";
import { decodeStoredToolRawResult } from "../session/session-store";

const testToolContext: ToolExecutionContext = {
  signal: new AbortController().signal,
};

function createDefaultTooling(
  options: Omit<
    Parameters<typeof createDefaultToolingBase>[0],
    "runtimeSession" | "historyReader"
  >,
) {
  const testRuntime = createTestRuntime();
  const tooling = createDefaultToolingBase({
    ...options,
    runtimeSession: testRuntime.runtimeSession,
    historyReader: createTestHistoryReader(testRuntime.runtimeSession.sessionId),
  });
  return {
    ...tooling,
    runtime: {
      execute: (
        call: TestToolCallInput | ToolCall,
        context: ToolExecutionContext = testToolContext,
      ) =>
        tooling.runtime.execute(
          "sessionId" in call ? call : testRuntime.toolCall(call),
          context,
        ),
    },
    testRuntime,
  };
}

describe("ToolRegistry", () => {
  test("rejects duplicate names with both registration sources", () => {
    const registry = new ToolRegistry();
    const executor = defineToolExecutor("generic", {
      definition: {
        name: "Duplicate",
        description: "duplicate test tool",
        parameters: { type: "object", properties: {} },
      },
      async execute() {
        return { ok: false, toolName: "Duplicate", error: "not executed" };
      },
    });

    registry.register(executor, "test-source-a");
    expect(() => registry.register(executor, "test-source-b")).toThrow(
      "Tool Duplicate from test-source-b conflicts with an existing registration from test-source-a",
    );
  });

  test("registers MemorySearch only when composition supplies its executor", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-memory-tool-"));
    const memorySearch = defineToolExecutor("memory_search", {
      definition: {
        name: "MemorySearch",
        description: "test memory search",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
      async execute() {
        return { ok: true, degraded: null, matches: [] };
      },
    });
    try {
      const withoutMemory = createDefaultTooling({ workspaceRoot: workspace });
      expect(
        withoutMemory.registry
          .definitions()
          .some((definition) => definition.name === "MemorySearch"),
      ).toBe(false);
      await withoutMemory.dispose();

      const withMemory = createDefaultTooling({
        workspaceRoot: workspace,
        memorySearch,
      });
      expect(
        withMemory.registry
          .definitions()
          .some((definition) => definition.name === "MemorySearch"),
      ).toBe(true);
      await withMemory.dispose();
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("registers MemoryGet only when composition supplies its executor", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-memory-tool-"));
    const memoryGet = defineToolExecutor("memory_get", {
      definition: {
        name: "MemoryGet",
        description: "test memory get",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
      async execute() {
        return { ok: true, memory: null };
      },
    });
    try {
      const withoutMemory = createDefaultTooling({ workspaceRoot: workspace });
      expect(
        withoutMemory.registry
          .definitions()
          .some((definition) => definition.name === "MemoryGet"),
      ).toBe(false);
      await withoutMemory.dispose();

      const withMemory = createDefaultTooling({
        workspaceRoot: workspace,
        memoryGet,
      });
      expect(
        withMemory.registry
          .definitions()
          .some((definition) => definition.name === "MemoryGet"),
      ).toBe(true);
      await withMemory.dispose();
    } finally {
      await rm(workspace, { recursive: true });
    }
  });
});

describe("UpdatePlan tool", () => {
  test("registers a bounded complete-snapshot schema", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-plan-tool-"));
    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const definition = tooling.registry
        .definitions()
        .find((candidate) => candidate.name === "UpdatePlan");
      expect(definition).toBeDefined();
      expect(definition?.parameters).toMatchObject({
        additionalProperties: false,
        required: ["plan"],
        properties: {
          explanation: { type: "string", maxLength: 500 },
          plan: { type: "array", maxItems: 12 },
        },
      });
      await tooling.dispose();
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("normalizes and returns a plan snapshot for persistence and presentation", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-plan-tool-"));
    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "provider-plan-1",
        name: "UpdatePlan",
        args: {
          explanation: "  Refined after inspection.  ",
          plan: [
            { step: "  Inspect implementation  ", status: "completed" },
            { step: "Add coverage", status: "in_progress" },
            { step: "Run checks", status: "pending" },
          ],
        },
      });

      expect(raw).toEqual({
        kind: "update_plan",
        ok: true,
        explanation: "Refined after inspection.",
        plan: [
          { step: "Inspect implementation", status: "completed" },
          { step: "Add coverage", status: "in_progress" },
          { step: "Run checks", status: "pending" },
        ],
      });
      expect(
        new ObservationBuilder().build({
          call: tooling.testRuntime.toolCall({
            providerToolCallId: "provider-plan-observation",
            name: "UpdatePlan",
            args: {},
          }),
          raw,
        }),
      ).toMatchObject({
        content: [{ type: "text", text: "Plan updated." }],
        displayText: "Plan updated.",
      });
      expect(decodeStoredToolRawResult(JSON.parse(JSON.stringify(raw)))).toEqual(raw);
      await tooling.dispose();
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("rejects multiple in-progress steps", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-plan-tool-"));
    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "provider-plan-invalid",
        name: "UpdatePlan",
        args: {
          plan: [
            { step: "First", status: "in_progress" },
            { step: "Second", status: "in_progress" },
          ],
        },
      });

      expect(raw).toEqual({
        kind: "update_plan",
        ok: false,
        error: "UpdatePlan allows at most one in_progress step.",
      });
      expect(
        new ObservationBuilder().build({
          call: tooling.testRuntime.toolCall({
            providerToolCallId: "provider-plan-failure-observation",
            name: "UpdatePlan",
            args: {},
          }),
          raw,
        }).displayText,
      ).toContain("UpdatePlan failed");
      await tooling.dispose();
    } finally {
      await rm(workspace, { recursive: true });
    }
  });
});

describe("Read and Write tools", () => {
  test("reads a workspace file with metadata", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tools-"));

    try {
      await writeFile(path.join(workspace, "notes.txt"), "a\nb\nc\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt", offset: 2, limit: 100 },
      });

      expect(raw.ok).toBe(true);
      expect("content" in raw ? raw.content : "").toBe("b\nc");
      expect("contentBytes" in raw ? raw.contentBytes : 0).toBe(3);
      expect("totalLines" in raw ? raw.totalLines : 0).toBe(3);
      expect("endLine" in raw ? raw.endLine : 0).toBe(3);
      expect("sha256" in raw ? raw.sha256 : undefined).toBeString();
      expect("truncated" in raw).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("fails an oversized unpaginated Read without returning partial content", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-read-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
      const tooling = createDefaultTooling({
        workspaceRoot: workspace,
        maxReadContentBytes: 15,
      });

      const read = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt" },
      });

      expect(read.ok).toBe(false);
      expect("content" in read ? read.content : undefined).toBeUndefined();
      expect("error" in read ? read.error : "").toBe(
        "File content (16 bytes) exceeds maximum allowed size (15 bytes). Use offset and limit parameters to read specific portions of the file.",
      );
      expect(tooling.snapshots.size).toBe(0);

      const edit = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
        },
      });
      expect(edit.ok).toBe(false);
      expect(
        "requiredReadBeforeEdit" in edit ? edit.requiredReadBeforeEdit : false,
      ).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("alpha\nbeta\ngamma\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("accepts exactly 262144 bytes and rejects 262145 bytes by default", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-read-"));

    try {
      await writeFile(
        path.join(workspace, "at-limit.txt"),
        `${"x".repeat(131_072)}\n${"y".repeat(131_071)}`,
        "utf8",
      );
      await writeFile(
        path.join(workspace, "over-limit.txt"),
        `${"x".repeat(131_072)}\n${"y".repeat(131_072)}`,
        "utf8",
      );
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      const atLimit = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "at-limit.txt" },
      });
      expect(atLimit.ok).toBe(true);
      expect("contentBytes" in atLimit ? atLimit.contentBytes : 0).toBe(262_144);

      const overLimit = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Read",
        args: { file_path: "over-limit.txt" },
      });
      expect(overLimit.ok).toBe(false);
      expect("error" in overLimit ? overLimit.error : "").toContain(
        "File content (262145 bytes) exceeds maximum allowed size (262144 bytes).",
      );
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("fails an oversized explicit range and accepts a smaller page", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-read-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
      const tooling = createDefaultTooling({
        workspaceRoot: workspace,
        maxReadContentBytes: 9,
      });

      const oversized = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt", offset: 2, limit: 2 },
      });
      expect(oversized.ok).toBe(false);
      expect("error" in oversized ? oversized.error : "").toBe(
        "Requested lines 2-3 contain 10 bytes and exceed the 9-byte Read limit. Reduce limit to request a smaller line range.",
      );

      const page = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Read",
        args: { file_path: "notes.txt", offset: 2, limit: 1 },
      });
      expect(page.ok).toBe(true);
      expect("content" in page ? page.content : "").toBe("beta");

      const edit = await tooling.runtime.execute({
        providerToolCallId: "call_3",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "gamma",
          new_string: "omega",
        },
      });
      expect(edit.ok).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("alpha\nbeta\nomega\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("reports a line that cannot fit within line-based pagination", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-read-"));

    try {
      await writeFile(path.join(workspace, "single-line.txt"), "x".repeat(11), "utf8");
      const tooling = createDefaultTooling({
        workspaceRoot: workspace,
        maxReadContentBytes: 10,
      });

      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "single-line.txt", offset: 1, limit: 1 },
      });

      expect(raw.ok).toBe(false);
      expect("error" in raw ? raw.error : "").toBe(
        "Line 1 is 11 bytes and exceeds the 10-byte Read limit. This line cannot be read with line-based pagination.",
      );
      expect(tooling.snapshots.size).toBe(0);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("rejects an offset beyond EOF without authorizing Edit", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-read-"));

    try {
      await writeFile(path.join(workspace, "notes.txt"), "a\nb\nc\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt", offset: 4, limit: 1 },
      });

      expect(raw.ok).toBe(false);
      expect("error" in raw ? raw.error : "").toBe(
        "Read.offset 4 exceeds the file's 3 lines.",
      );
      expect(tooling.snapshots.size).toBe(0);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("reads an empty file without pagination and records a valid Read", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-read-"));

    try {
      const filePath = path.join(workspace, "empty.txt");
      await writeFile(filePath, "", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "empty.txt" },
      });

      expect(raw.ok).toBe(true);
      expect("content" in raw ? raw.content : undefined).toBe("");
      expect("totalLines" in raw ? raw.totalLines : undefined).toBe(0);
      expect(tooling.snapshots.get(filePath)?.source).toBe("read");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("keeps the last valid Read when a later Read request is too large", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-read-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
      const tooling = createDefaultTooling({
        workspaceRoot: workspace,
        maxReadContentBytes: 5,
      });

      const page = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt", offset: 2, limit: 1 },
      });
      expect(page.ok).toBe(true);

      const oversized = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Read",
        args: { file_path: "notes.txt" },
      });
      expect(oversized.ok).toBe(false);

      const edit = await tooling.runtime.execute({
        providerToolCallId: "call_3",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "gamma",
          new_string: "omega",
        },
      });
      expect(edit.ok).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("alpha\nbeta\nomega\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("rejects path escape", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tools-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "../outside.txt" },
      });

      expect(raw.ok).toBe(false);
      expect("error" in raw ? raw.error : "").toContain("escapes workspace");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("reads and writes an absolute file path outside the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tinker-tools-"));
    const workspace = path.join(root, "workspace");
    const filePath = path.join(root, "outside.txt");

    try {
      await mkdir(workspace);
      await writeFile(filePath, "before\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      const read = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: filePath },
      });
      expect(read.ok).toBe(true);
      expect("content" in read ? read.content : "").toBe("before");

      const write = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Write",
        args: { file_path: filePath, content: "after\n" },
      });
      expect(write.ok).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("after\n");
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test("writes a new file", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tools-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Write",
        args: { file_path: "notes.txt", content: "hello\n" },
      });

      expect(raw.ok).toBe(true);
      expect(await readFile(path.join(workspace, "notes.txt"), "utf8")).toBe("hello\n");
      expect("created" in raw ? raw.created : false).toBe(true);
      const patch = "patch" in raw ? raw.patch : undefined;
      expect(patch?.[0]?.lines).toEqual(["+hello"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("creates missing parent directories for a new file", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tools-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const filePath = path.join(workspace, "src", "generated", "api", "client.ts");
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Write",
        args: {
          file_path: "src/generated/api/client.ts",
          content: "export const client = true;\n",
        },
      });

      expect(raw.ok).toBe(true);
      expect((await stat(path.dirname(filePath))).isDirectory()).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("export const client = true;\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("creates missing parent directories for an absolute file path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tinker-tools-"));
    const workspace = path.join(root, "workspace");
    const filePath = path.join(root, "outside", "nested", "notes.txt");

    try {
      await mkdir(workspace);
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Write",
        args: { file_path: filePath, content: "outside\n" },
      });

      expect(raw.ok).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("outside\n");
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test("fails when a Write parent path is a file", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tools-"));
    const blocker = path.join(workspace, "blocker");

    try {
      await writeFile(blocker, "unchanged\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Write",
        args: { file_path: "blocker/nested/notes.txt", content: "new\n" },
      });

      expect(raw.ok).toBe(false);
      expect("error" in raw ? raw.error : "").toContain(
        "Failed to create parent directory:",
      );
      expect("error" in raw ? raw.error : "").toContain("not a directory");
      expect(await readFile(blocker, "utf8")).toBe("unchanged\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("returns a structured patch when overwriting after Read", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tools-"));

    try {
      await writeFile(path.join(workspace, "notes.txt"), "old\nsame\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt" },
      });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Write",
        args: { file_path: "notes.txt", content: "new\nsame\n" },
      });

      expect(raw.ok).toBe(true);
      expect("created" in raw ? raw.created : true).toBe(false);
      const patch = "patch" in raw ? raw.patch : undefined;
      expect(patch?.[0]?.lines).toEqual(["-old", "+new", " same"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("requires Read before overwriting an existing file", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tools-"));

    try {
      await writeFile(path.join(workspace, "notes.txt"), "old\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Write",
        args: { file_path: "notes.txt", content: "new\n" },
      });

      expect(raw.ok).toBe(false);
      expect(
        "requiredReadBeforeWrite" in raw ? raw.requiredReadBeforeWrite : false,
      ).toBe(true);
      expect(await readFile(path.join(workspace, "notes.txt"), "utf8")).toBe("old\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("rejects Write when file changed after Read", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-tools-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "old\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt" },
      });
      await writeFile(filePath, "external\n", "utf8");

      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Write",
        args: { file_path: "notes.txt", content: "new\n" },
      });

      expect(raw.ok).toBe(false);
      expect("error" in raw ? raw.error : "").toContain("changed");
      expect(await readFile(filePath, "utf8")).toBe("external\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("Edit tool", () => {
  test("replaces a single exact string after Read and keeps chained edits authorized", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt" },
      });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
        },
      });

      expect(raw.ok).toBe(true);
      expect("replacementCount" in raw ? raw.replacementCount : 0).toBe(1);
      const secondRaw = await tooling.runtime.execute({
        providerToolCallId: "call_3",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "gamma",
          new_string: "omega",
        },
      });

      expect(secondRaw.ok).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("alpha\ndelta\nomega\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("edits an absolute file path outside the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));
    const workspace = path.join(root, "workspace");
    const filePath = path.join(root, "outside.txt");

    try {
      await mkdir(workspace);
      await writeFile(filePath, "old value\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: filePath },
      });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Edit",
        args: {
          file_path: filePath,
          old_string: "old value",
          new_string: "new value",
        },
      });

      expect(raw.ok).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("new value\n");
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test("returns a structured patch describing the edit", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt" },
      });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
        },
      });

      expect(raw.ok).toBe(true);
      const patch = "patch" in raw ? raw.patch : undefined;
      expect(patch).toHaveLength(1);
      expect(patch?.[0]?.lines).toEqual([" alpha", "-beta", "+delta", " gamma"]);
      expect("patchTruncated" in raw ? raw.patchTruncated : undefined).toBe(false);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("returns an all-additions patch when creating a file", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Edit",
        args: {
          file_path: "fresh.txt",
          old_string: "",
          new_string: "a\nb\n",
        },
      });

      expect(raw.ok).toBe(true);
      expect("created" in raw ? raw.created : false).toBe(true);
      const patch = "patch" in raw ? raw.patch : undefined;
      expect(patch?.[0]?.lines).toEqual(["+a", "+b"]);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("creates missing parent directories in Edit creation mode", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const filePath = path.join(workspace, "src", "generated", "client.ts");
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Edit",
        args: {
          file_path: "src/generated/client.ts",
          old_string: "",
          new_string: "export const client = true;\n",
        },
      });

      expect(raw.ok).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("export const client = true;\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("does not create parent directories for a missing ordinary Edit target", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));
    const parentPath = path.join(workspace, "missing", "nested");

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Edit",
        args: {
          file_path: "missing/nested/notes.txt",
          old_string: "old",
          new_string: "new",
        },
      });

      expect(raw.ok).toBe(false);
      expect("error" in raw ? raw.error : "").toBe("File does not exist.");
      expect(stat(parentPath)).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("fails when an Edit creation parent path is a file", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));
    const blocker = path.join(workspace, "blocker");

    try {
      await writeFile(blocker, "unchanged\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Edit",
        args: {
          file_path: "blocker/nested/notes.txt",
          old_string: "",
          new_string: "new\n",
        },
      });

      expect(raw.ok).toBe(false);
      expect("error" in raw ? raw.error : "").toContain(
        "Failed to create parent directory:",
      );
      expect("error" in raw ? raw.error : "").toContain("not a directory");
      expect(await readFile(blocker, "utf8")).toBe("unchanged\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("reports a missing target when an ordinary Edit parent path is a file", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));
    const blocker = path.join(workspace, "blocker");

    try {
      await writeFile(blocker, "unchanged\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Edit",
        args: {
          file_path: "blocker/nested/notes.txt",
          old_string: "old",
          new_string: "new",
        },
      });

      expect(raw.ok).toBe(false);
      expect("error" in raw ? raw.error : "").toBe("File does not exist.");
      expect(await readFile(blocker, "utf8")).toBe("unchanged\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("allows Edit after a successful paginated Read", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt", offset: 2, limit: 1 },
      });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
        },
      });

      expect(raw.ok).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("alpha\ndelta\ngamma\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("requires a successful Read before editing", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const call = tooling.testRuntime.toolCall({
        providerToolCallId: "call_1",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
        },
      });

      const raw = await tooling.runtime.execute(call);
      expect(raw.ok).toBe(false);
      expect("requiredReadBeforeEdit" in raw ? raw.requiredReadBeforeEdit : false).toBe(
        true,
      );
      const observation = new ObservationBuilder().build({ call, raw });
      expect(observation.displayText).toBe(
        "Edit failed for notes.txt: File must be read before Edit. Call Read on this file before trying Edit again.",
      );
      expect(await readFile(filePath, "utf8")).toBe("alpha\nbeta\ngamma\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("allows Edit after Write refreshes the known version", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt", offset: 1, limit: 1 },
      });
      const write = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Write",
        args: { file_path: "notes.txt", content: "alpha\nbeta\ngamma\n" },
      });
      expect(write.ok).toBe(true);

      const edit = await tooling.runtime.execute({
        providerToolCallId: "call_3",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
        },
      });
      expect(edit.ok).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("alpha\ndelta\ngamma\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("allows Edit immediately after Write creates a file", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      const write = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Write",
        args: { file_path: "notes.txt", content: "alpha\nbeta\n" },
      });
      expect(write.ok).toBe(true);

      const edit = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
        },
      });

      expect(edit.ok).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("alpha\ndelta\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("rejects Edit after a file written by Write changes externally", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      const write = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Write",
        args: { file_path: "notes.txt", content: "alpha\nbeta\n" },
      });
      expect(write.ok).toBe(true);
      const snapshot = tooling.snapshots.get(filePath);
      if (snapshot === undefined) {
        throw new Error("Write did not record a file snapshot.");
      }

      await writeFile(filePath, "alpha\nbeta\nexternal\n", "utf8");
      const earlier = new Date(snapshot.mtimeMs - 60_000);
      await utimes(filePath, earlier, earlier);
      expect((await stat(filePath)).mtimeMs).toBeLessThan(snapshot.mtimeMs);

      const edit = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
        },
      });

      expect(edit.ok).toBe(false);
      expect("currentSha256" in edit ? edit.currentSha256 : undefined).toBeString();
      expect("lastObservedSha256" in edit ? edit.lastObservedSha256 : undefined).toBe(
        snapshot.sha256,
      );
      expect("error" in edit ? edit.error : "").toBe(
        "File changed after it was last observed. Read it again before Edit.",
      );
      expect(await readFile(filePath, "utf8")).toBe("alpha\nbeta\nexternal\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("requires Read when a new runtime has no snapshot from an earlier Write", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      const firstTooling = createDefaultTooling({ workspaceRoot: workspace });
      const write = await firstTooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Write",
        args: { file_path: "notes.txt", content: "alpha\nbeta\n" },
      });
      expect(write.ok).toBe(true);

      const nextTooling = createDefaultTooling({ workspaceRoot: workspace });
      const edit = await nextTooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
        },
      });

      expect(edit.ok).toBe(false);
      expect(
        "requiredReadBeforeEdit" in edit ? edit.requiredReadBeforeEdit : false,
      ).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("alpha\nbeta\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("rejects Edit when content changed even with an older mtime", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt" },
      });
      const snapshot = tooling.snapshots.get(filePath);
      if (snapshot === undefined) {
        throw new Error("Read did not record a file snapshot.");
      }
      await writeFile(filePath, "alpha\nbeta\nexternal\n", "utf8");
      const earlier = new Date(snapshot.mtimeMs - 60_000);
      await utimes(filePath, earlier, earlier);
      expect((await stat(filePath)).mtimeMs).toBeLessThan(snapshot.mtimeMs);

      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
        },
      });

      expect(raw.ok).toBe(false);
      expect("error" in raw ? raw.error : "").toBe(
        "File changed after it was last observed. Read it again before Edit.",
      );
      expect(await readFile(filePath, "utf8")).toBe("alpha\nbeta\nexternal\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("allows Edit when only mtime changed after Read", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt" },
      });
      const future = new Date(Date.now() + 60_000);
      await utimes(filePath, future, future);

      const edit = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
        },
      });

      expect(edit.ok).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("alpha\ndelta\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("rejects missing and ambiguous old_string matches", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\nbeta\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt" },
      });

      const missing = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "omega",
          new_string: "delta",
        },
      });
      expect(missing.ok).toBe(false);
      expect("error" in missing ? missing.error : "").toContain("not found");

      const ambiguous = await tooling.runtime.execute({
        providerToolCallId: "call_3",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
        },
      });
      expect(ambiguous.ok).toBe(false);
      expect("replacementCount" in ambiguous ? ambiguous.replacementCount : 0).toBe(2);
      expect(await readFile(filePath, "utf8")).toBe("alpha\nbeta\nbeta\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("replace_all=true replaces every exact string match", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const filePath = path.join(workspace, "notes.txt");
      await writeFile(filePath, "alpha\nbeta\nbeta\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "notes.txt" },
      });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Edit",
        args: {
          file_path: "notes.txt",
          old_string: "beta",
          new_string: "delta",
          replace_all: true,
        },
      });

      expect(raw.ok).toBe(true);
      expect("replacementCount" in raw ? raw.replacementCount : 0).toBe(2);
      expect(await readFile(filePath, "utf8")).toBe("alpha\ndelta\ndelta\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("old_string='' creates a file or writes to an empty file only", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-edit-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const created = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Edit",
        args: {
          file_path: "created.txt",
          old_string: "",
          new_string: "seed\n",
        },
      });
      expect(created.ok).toBe(true);
      expect(await readFile(path.join(workspace, "created.txt"), "utf8")).toBe(
        "seed\n",
      );

      await writeFile(path.join(workspace, "empty.txt"), "", "utf8");
      const empty = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Edit",
        args: {
          file_path: "empty.txt",
          old_string: "",
          new_string: "filled\n",
        },
      });
      expect(empty.ok).toBe(true);
      expect(await readFile(path.join(workspace, "empty.txt"), "utf8")).toBe(
        "filled\n",
      );

      const nonEmpty = await tooling.runtime.execute({
        providerToolCallId: "call_3",
        name: "Edit",
        args: {
          file_path: "created.txt",
          old_string: "",
          new_string: "overwrite\n",
        },
      });
      expect(nonEmpty.ok).toBe(false);
      expect(await readFile(path.join(workspace, "created.txt"), "utf8")).toBe(
        "seed\n",
      );
    } finally {
      await rm(workspace, { recursive: true });
    }
  });
});

describe("Delete tool", () => {
  test("registers the exact schema after Edit and before Bash", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-delete-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const definitions = tooling.registry.definitions();
      const names = definitions.map((definition) => definition.name);
      const definition = definitions.find((candidate) => candidate.name === "Delete");

      expect(definition).toEqual({
        name: "Delete",
        description:
          "Delete one existing regular file. Directories and symbolic links are not supported.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            file_path: {
              type: "string",
              description: "Workspace-relative path or absolute path.",
            },
          },
          required: ["file_path"],
        },
      });
      expect(names.slice(names.indexOf("Edit"), names.indexOf("Bash") + 1)).toEqual([
        "Edit",
        "Delete",
        "Bash",
      ]);
      expect(
        decodeStoredToolRawResult({
          kind: "delete",
          ok: true,
          filePath: "obsolete.ts",
          absolutePath: path.join(workspace, "obsolete.ts"),
        }),
      ).toEqual({
        kind: "delete",
        ok: true,
        filePath: "obsolete.ts",
        absolutePath: path.join(workspace, "obsolete.ts"),
      });
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("deletes a workspace file without a snapshot and renders success", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-delete-"));
    const filePath = path.join(workspace, "obsolete.ts");

    try {
      await writeFile(filePath, "obsolete\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const call = {
        providerToolCallId: "call_1",
        name: "Delete",
        args: { file_path: "obsolete.ts" },
      };
      const raw = await tooling.runtime.execute(call);
      const observation = new ObservationBuilder().build({
        call: tooling.testRuntime.toolCall(call),
        raw,
      });

      expect(raw).toEqual({
        kind: "delete",
        ok: true,
        filePath: "obsolete.ts",
        absolutePath: filePath,
      });
      expect(lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(tooling.snapshots.size).toBe(0);
      expect(observation.displayText).toBe("Delete succeeded for obsolete.ts.");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("deletes an absolute file outside the workspace", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "tinker-delete-absolute-"));
    const workspace = path.join(parent, "workspace");
    const filePath = path.join(parent, "outside.txt");

    try {
      await mkdir(workspace);
      await writeFile(filePath, "outside\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Delete",
        args: { file_path: filePath },
      });

      expect(raw).toMatchObject({
        kind: "delete",
        ok: true,
        filePath,
        absolutePath: filePath,
      });
      expect(lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(parent, { recursive: true });
    }
  });

  test("deletes files with Read, Write, or Edit snapshots and clears each snapshot", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-delete-snapshot-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const readPath = path.join(workspace, "read.txt");
      await writeFile(readPath, "read\n", "utf8");
      await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "read.txt" },
      });
      expect(tooling.snapshots.get(readPath)?.source).toBe("read");

      const readDelete = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Delete",
        args: { file_path: "read.txt" },
      });
      expect(readDelete.ok).toBe(true);
      expect(tooling.snapshots.has(readPath)).toBe(false);

      const writePath = path.join(workspace, "write.txt");
      await tooling.runtime.execute({
        providerToolCallId: "call_3",
        name: "Write",
        args: { file_path: "write.txt", content: "write\n" },
      });
      expect(tooling.snapshots.get(writePath)?.source).toBe("write");

      const writeDelete = await tooling.runtime.execute({
        providerToolCallId: "call_4",
        name: "Delete",
        args: { file_path: "write.txt" },
      });
      expect(writeDelete.ok).toBe(true);
      expect(tooling.snapshots.has(writePath)).toBe(false);

      const editPath = path.join(workspace, "edit.txt");
      await writeFile(editPath, "before\n", "utf8");
      await tooling.runtime.execute({
        providerToolCallId: "call_5",
        name: "Read",
        args: { file_path: "edit.txt" },
      });
      await tooling.runtime.execute({
        providerToolCallId: "call_6",
        name: "Edit",
        args: {
          file_path: "edit.txt",
          old_string: "before",
          new_string: "after",
        },
      });
      expect(tooling.snapshots.get(editPath)?.source).toBe("edit");

      const editDelete = await tooling.runtime.execute({
        providerToolCallId: "call_7",
        name: "Delete",
        args: { file_path: "edit.txt" },
      });
      expect(editDelete.ok).toBe(true);
      expect(tooling.snapshots.has(editPath)).toBe(false);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("validates arguments and workspace-relative paths", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-delete-args-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const cases = [
        {
          args: null,
          filePath: "",
          error: "Delete arguments must be an object.",
        },
        {
          args: [],
          filePath: "",
          error: "Delete arguments must be an object.",
        },
        {
          args: {},
          filePath: "",
          error: "Delete.file_path must be a string.",
        },
        {
          args: { file_path: 42 },
          filePath: "",
          error: "Delete.file_path must be a string.",
        },
        {
          args: { file_path: "" },
          filePath: "",
          error: "Path is required.",
        },
        {
          args: { file_path: " \t " },
          filePath: " \t ",
          error: "Path is required.",
        },
        {
          args: { file_path: "../outside.txt" },
          filePath: "../outside.txt",
          error: "Path escapes workspace.",
        },
      ];

      for (const [index, testCase] of cases.entries()) {
        const raw = await tooling.runtime.execute({
          providerToolCallId: `call_${index + 1}`,
          name: "Delete",
          args: testCase.args,
        });

        expect(raw).toMatchObject({
          kind: "delete",
          ok: false,
          filePath: testCase.filePath,
          error: testCase.error,
        });
      }
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("normalizes missing files and ENOTDIR to ordinary Delete failures", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-delete-missing-"));

    try {
      await writeFile(path.join(workspace, "parent-file"), "parent\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      for (const filePath of ["missing.txt", "parent-file/child.txt"]) {
        const call = {
          providerToolCallId: `call_${filePath}`,
          name: "Delete",
          args: { file_path: filePath },
        };
        const raw = await tooling.runtime.execute(call);
        const observation = new ObservationBuilder().build({
          call: tooling.testRuntime.toolCall(call),
          raw,
        });

        expect(raw).toMatchObject({
          kind: "delete",
          ok: false,
          filePath,
          error: "File does not exist.",
        });
        expect(observation.displayText).toBe(
          `Delete failed for ${filePath}: File does not exist.`,
        );
      }
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("rejects empty and non-empty directories without changing them", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-delete-directory-"));
    const emptyPath = path.join(workspace, "empty");
    const nonEmptyPath = path.join(workspace, "non-empty");
    const childPath = path.join(nonEmptyPath, "child.txt");

    try {
      await mkdir(emptyPath);
      await mkdir(nonEmptyPath);
      await writeFile(childPath, "keep\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      for (const filePath of ["empty", "non-empty"]) {
        const raw = await tooling.runtime.execute({
          providerToolCallId: `call_${filePath}`,
          name: "Delete",
          args: { file_path: filePath },
        });

        expect(raw).toMatchObject({
          kind: "delete",
          ok: false,
          filePath,
          error: "Path is not a regular file.",
        });
      }

      expect((await lstat(emptyPath)).isDirectory()).toBe(true);
      expect((await lstat(nonEmptyPath)).isDirectory()).toBe(true);
      expect(await readFile(childPath, "utf8")).toBe("keep\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("rejects symbolic links without changing the link or its target", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-delete-symlink-"));
    const targetPath = path.join(workspace, "target.txt");
    const linkPath = path.join(workspace, "current-config");

    try {
      await writeFile(targetPath, "keep\n", "utf8");
      await symlink(targetPath, linkPath);
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Delete",
        args: { file_path: "current-config" },
      });

      expect(raw).toMatchObject({
        kind: "delete",
        ok: false,
        filePath: "current-config",
        error: "Symbolic links are not supported.",
      });
      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(await readFile(targetPath, "utf8")).toBe("keep\n");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("rejects a FIFO without opening or removing it", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-delete-fifo-"));
    const fifoPath = path.join(workspace, "events.pipe");

    try {
      const child = Bun.spawnSync(["mkfifo", fifoPath]);
      if (child.exitCode !== 0) {
        throw new Error(`mkfifo failed: ${child.stderr.toString()}`);
      }
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Delete",
        args: { file_path: "events.pipe" },
      });

      expect(raw).toMatchObject({
        kind: "delete",
        ok: false,
        filePath: "events.pipe",
        error: "Path is not a regular file.",
      });
      expect((await lstat(fifoPath)).isFIFO()).toBe(true);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("keeps the file and snapshot when rm fails", async () => {
    if (process.getuid?.() === 0) {
      return;
    }

    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "tinker-delete-permission-"),
    );
    const filePath = path.join(workspace, "protected.txt");

    try {
      await writeFile(filePath, "keep\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Read",
        args: { file_path: "protected.txt" },
      });
      const snapshot = tooling.snapshots.get(filePath);
      await chmod(workspace, 0o555);

      let raw;
      try {
        raw = await tooling.runtime.execute({
          providerToolCallId: "call_2",
          name: "Delete",
          args: { file_path: "protected.txt" },
        });
      } finally {
        await chmod(workspace, 0o755);
      }

      expect(raw).toMatchObject({
        kind: "delete",
        ok: false,
        filePath: "protected.txt",
      });
      expect("error" in raw ? raw.error : "").toMatch(
        /EACCES|EPERM|permission denied/i,
      );
      expect(await readFile(filePath, "utf8")).toBe("keep\n");
      expect(tooling.snapshots.get(filePath)).toEqual(snapshot);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });
});

describe("Glob tool", () => {
  test("finds workspace files, includes dotfiles, and ignores node_modules and .git", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-glob-"));

    try {
      await mkdir(path.join(workspace, "src"), { recursive: true });
      await mkdir(path.join(workspace, "node_modules", "pkg"), {
        recursive: true,
      });
      await mkdir(path.join(workspace, ".git"), { recursive: true });
      await writeFile(path.join(workspace, "src", "app.ts"), "", "utf8");
      await writeFile(path.join(workspace, ".env.example"), "", "utf8");
      await writeFile(
        path.join(workspace, "node_modules", "pkg", "ignored.ts"),
        "",
        "utf8",
      );
      await writeFile(path.join(workspace, ".git", "config"), "", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Glob",
        args: { pattern: "**/*" },
      });

      expect(raw.ok).toBe(true);
      const matches = "matches" in raw ? (raw.matches ?? []) : [];
      expect(matches).toContain(".env.example");
      expect(matches).toContain("src/app.ts");
      expect(matches).not.toContain("node_modules/pkg/ignored.ts");
      expect(matches).not.toContain(".git/config");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("uses optional path as the search directory", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-glob-"));

    try {
      await mkdir(path.join(workspace, "src"), { recursive: true });
      await mkdir(path.join(workspace, "docs"), { recursive: true });
      await writeFile(path.join(workspace, "src", "app.ts"), "", "utf8");
      await writeFile(path.join(workspace, "docs", "guide.ts"), "", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Glob",
        args: { pattern: "*.ts", path: "src" },
      });

      expect(raw.ok).toBe(true);
      expect("searchPath" in raw ? raw.searchPath : "").toBe("src");
      expect("matches" in raw ? raw.matches : []).toEqual(["src/app.ts"]);
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("searches an absolute directory outside the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tinker-glob-"));
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    const filePath = path.join(outside, "app.ts");

    try {
      await mkdir(workspace);
      await mkdir(outside);
      await writeFile(filePath, "", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Glob",
        args: { pattern: "*.ts", path: outside },
      });

      expect(raw.ok).toBe(true);
      expect("searchPath" in raw ? raw.searchPath : "").toBe(outside);
      expect("matches" in raw ? raw.matches : []).toEqual([filePath]);
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test("rejects Glob path escape", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-glob-"));

    try {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Glob",
        args: { pattern: "**/*.ts", path: "../outside" },
      });

      expect(raw.ok).toBe(false);
      expect("error" in raw ? raw.error : "").toContain("escapes workspace");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });

  test("renders model-visible Glob observation as a path list", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-glob-"));

    try {
      await mkdir(path.join(workspace, "src"), { recursive: true });
      await writeFile(path.join(workspace, "src", "app.ts"), "", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const call = tooling.testRuntime.toolCall({
        providerToolCallId: "call_1",
        name: "Glob",
        args: { pattern: "**/*.ts" },
      });
      const raw = await tooling.runtime.execute(call);
      const observation = new ObservationBuilder().build({ call, raw });

      expect(observation.displayText).toContain(
        'Glob succeeded for pattern="**/*.ts".',
      );
      expect(observation.displayText).toContain("searchPath=.");
      expect(observation.displayText).toContain("ignored=node_modules,.git");
      expect(observation.displayText).toContain("matches:\nsrc/app.ts");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });
});

describe("Grep tool", () => {
  async function withGrepWorkspace(
    callback: (workspace: string) => Promise<void>,
  ): Promise<void> {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-grep-"));

    try {
      await callback(workspace);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  test("registry exposes the Grep schema", async () => {
    await withGrepWorkspace(async (workspace) => {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const definition = tooling.registry
        .definitions()
        .find((tool) => tool.name === "Grep");

      expect(definition).toBeDefined();
      expect(definition?.parameters.additionalProperties).toBe(false);
      expect(definition?.parameters.required).toEqual(["pattern"]);
    });
  });

  test("defaults to files_with_matches with workspace-relative paths", async () => {
    await withGrepWorkspace(async (workspace) => {
      await mkdir(path.join(workspace, "src"), { recursive: true });
      await writeFile(path.join(workspace, "src", "a.ts"), "foo()\n", "utf8");
      await writeFile(path.join(workspace, "src", "b.ts"), "foo()\n", "utf8");
      await writeFile(path.join(workspace, "src", "c.ts"), "bar()\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo" },
      });

      expect(raw.ok).toBe(true);
      expect("mode" in raw ? raw.mode : "").toBe("files_with_matches");
      expect("filenames" in raw ? raw.filenames : []).toEqual(["src/a.ts", "src/b.ts"]);
      expect("numFiles" in raw ? raw.numFiles : 0).toBe(2);
    });
  });

  test("content mode returns matching lines with line numbers", async () => {
    await withGrepWorkspace(async (workspace) => {
      await mkdir(path.join(workspace, "src"), { recursive: true });
      await writeFile(path.join(workspace, "src", "a.ts"), "alpha\nfoo()\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo", output_mode: "content" },
      });

      expect(raw.ok).toBe(true);
      expect("content" in raw ? raw.content : "").toBe("src/a.ts:2:foo()");
      expect("numLines" in raw ? raw.numLines : 0).toBe(1);
    });
  });

  test("content mode supports context lines", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.txt"), "alpha\nfoo\ngamma\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo", output_mode: "content", "-C": 1 },
      });

      expect(raw.ok).toBe(true);
      const content = "content" in raw ? (raw.content ?? "") : "";
      expect(content).toContain("a.txt-1-alpha");
      expect(content).toContain("a.txt:2:foo");
      expect(content).toContain("a.txt-3-gamma");
    });
  });

  test("count mode returns per-file counts and total matches", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.ts"), "foo\nfoo\n", "utf8");
      await writeFile(path.join(workspace, "b.ts"), "foo\nfoo\nfoo\nbar\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo", output_mode: "count" },
      });

      expect(raw.ok).toBe(true);
      expect("content" in raw ? raw.content : "").toBe("a.ts:2\nb.ts:3");
      expect("numMatches" in raw ? raw.numMatches : 0).toBe(5);
      expect("numFiles" in raw ? raw.numFiles : 0).toBe(2);
    });
  });

  test("applies head_limit and offset pagination", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.ts"), "foo\n", "utf8");
      await writeFile(path.join(workspace, "b.ts"), "foo\n", "utf8");
      await writeFile(path.join(workspace, "c.ts"), "foo\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const firstPage = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo", head_limit: 2 },
      });

      expect(firstPage.ok).toBe(true);
      expect("filenames" in firstPage ? firstPage.filenames : []).toEqual([
        "a.ts",
        "b.ts",
      ]);
      expect("appliedLimit" in firstPage ? firstPage.appliedLimit : undefined).toBe(2);
      expect("truncated" in firstPage ? firstPage.truncated : undefined).toBe(true);

      const secondPage = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Grep",
        args: { pattern: "foo", head_limit: 2, offset: 2 },
      });

      expect(secondPage.ok).toBe(true);
      expect("filenames" in secondPage ? secondPage.filenames : []).toEqual(["c.ts"]);
      expect(
        "appliedLimit" in secondPage ? secondPage.appliedLimit : undefined,
      ).toBeUndefined();
      expect("appliedOffset" in secondPage ? secondPage.appliedOffset : undefined).toBe(
        2,
      );
    });
  });

  test("filters by glob and type", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.ts"), "foo\n", "utf8");
      await writeFile(path.join(workspace, "b.js"), "foo\n", "utf8");
      await writeFile(path.join(workspace, "c.md"), "foo\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const globFiltered = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo", glob: "*.ts" },
      });
      expect("filenames" in globFiltered ? globFiltered.filenames : []).toEqual([
        "a.ts",
      ]);

      const typeFiltered = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Grep",
        args: { pattern: "foo", type: "js" },
      });
      expect("filenames" in typeFiltered ? typeFiltered.filenames : []).toEqual([
        "b.js",
      ]);
    });
  });

  test("supports case-insensitive and multiline search", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.ts"), "FOO\nbar\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const caseSensitive = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo" },
      });
      expect("numFiles" in caseSensitive ? caseSensitive.numFiles : -1).toBe(0);

      const caseInsensitive = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Grep",
        args: { pattern: "foo", "-i": true },
      });
      expect("filenames" in caseInsensitive ? caseInsensitive.filenames : []).toEqual([
        "a.ts",
      ]);

      const withoutMultiline = await tooling.runtime.execute({
        providerToolCallId: "call_3",
        name: "Grep",
        args: { pattern: "FOO.bar" },
      });
      expect("numFiles" in withoutMultiline ? withoutMultiline.numFiles : -1).toBe(0);

      const multiline = await tooling.runtime.execute({
        providerToolCallId: "call_4",
        name: "Grep",
        args: { pattern: "FOO.bar", multiline: true },
      });
      expect("filenames" in multiline ? multiline.filenames : []).toEqual(["a.ts"]);
    });
  });

  test("searches patterns that start with a dash", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.sh"), "run --verbose\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "--verbose" },
      });

      expect(raw.ok).toBe(true);
      expect("filenames" in raw ? raw.filenames : []).toEqual(["a.sh"]);
    });
  });

  test("returns ok with empty results when nothing matches", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.ts"), "alpha\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "missing" },
      });

      expect(raw.ok).toBe(true);
      expect("filenames" in raw ? raw.filenames : ["x"]).toEqual([]);
      expect("numFiles" in raw ? raw.numFiles : -1).toBe(0);
    });
  });

  test("supports searching a single file path", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.ts"), "foo\n", "utf8");
      await writeFile(path.join(workspace, "b.ts"), "foo\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo", path: "a.ts", output_mode: "content" },
      });

      expect(raw.ok).toBe(true);
      expect("content" in raw ? raw.content : "").toBe("a.ts:1:foo");
    });
  });

  test("searches an absolute file path outside the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tinker-grep-"));
    const workspace = path.join(root, "workspace");
    const filePath = path.join(root, "outside.ts");

    try {
      await mkdir(workspace);
      await writeFile(filePath, "foo\n", "utf8");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo", path: filePath, output_mode: "content" },
      });

      expect(raw.ok).toBe(true);
      expect("searchPath" in raw ? raw.searchPath : "").toBe(filePath);
      expect("content" in raw ? raw.content : "").toBe(`${filePath}:1:foo`);
      expect("filenames" in raw ? raw.filenames : []).toEqual([filePath]);
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test("rejects path escape and missing paths", async () => {
    await withGrepWorkspace(async (workspace) => {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });

      const escape = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo", path: "../outside" },
      });
      expect(escape.ok).toBe(false);
      expect("error" in escape ? escape.error : "").toContain("escapes workspace");

      const missing = await tooling.runtime.execute({
        providerToolCallId: "call_2",
        name: "Grep",
        args: { pattern: "foo", path: "does-not-exist" },
      });
      expect(missing.ok).toBe(false);
      expect("error" in missing ? missing.error : "").toContain("does not exist");
    });
  });

  test("ignores node_modules, .git, and .tinker by default", async () => {
    await withGrepWorkspace(async (workspace) => {
      await mkdir(path.join(workspace, "node_modules", "pkg"), { recursive: true });
      await mkdir(path.join(workspace, ".git"), { recursive: true });
      await mkdir(path.join(workspace, ".tinker"), { recursive: true });
      await writeFile(path.join(workspace, "a.ts"), "foo\n", "utf8");
      await writeFile(
        path.join(workspace, "node_modules", "pkg", "b.ts"),
        "foo\n",
        "utf8",
      );
      await writeFile(path.join(workspace, ".git", "config"), "foo\n", "utf8");
      await writeFile(path.join(workspace, ".tinker", "log.md"), "foo\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo" },
      });

      expect(raw.ok).toBe(true);
      expect("filenames" in raw ? raw.filenames : []).toEqual(["a.ts"]);
    });
  });

  test("fails with a clear error when ripgrep is missing", async () => {
    await withGrepWorkspace(async (workspace) => {
      const tooling = createDefaultTooling({
        workspaceRoot: workspace,
        toolingConfig: {
          ...DEFAULT_PUBLIC_TOOLING_CONFIG,
          ripgrepPath: path.join(workspace, "missing-rg"),
        },
      });
      const raw = await tooling.runtime.execute({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo" },
      });

      expect(raw.ok).toBe(false);
      expect("error" in raw ? raw.error : "").toBe(
        "Tinker's bundled ripgrep executable is unavailable. Reinstall tinker-agent.",
      );
    });
  });

  test("renders files_with_matches observations", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.ts"), "foo\n", "utf8");
      await writeFile(path.join(workspace, "b.ts"), "foo\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const call = tooling.testRuntime.toolCall({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo" },
      });
      const raw = await tooling.runtime.execute(call);
      const observation = new ObservationBuilder().build({ call, raw });

      expect(observation.displayText).toBe("Found 2 files\na.ts\nb.ts");

      const emptyCall = tooling.testRuntime.toolCall({
        providerToolCallId: "call_2",
        name: "Grep",
        args: { pattern: "missing" },
      });
      const emptyRaw = await tooling.runtime.execute(emptyCall);
      const emptyObservation = new ObservationBuilder().build({
        call: emptyCall,
        raw: emptyRaw,
      });

      expect(emptyObservation.displayText).toBe("No files found");
    });
  });

  test("renders content and count observations", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.ts"), "foo\n", "utf8");
      await writeFile(path.join(workspace, "b.ts"), "foo\nfoo\nfoo\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const contentCall = tooling.testRuntime.toolCall({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo", path: "a.ts", output_mode: "content" },
      });
      const contentRaw = await tooling.runtime.execute(contentCall);
      const contentObservation = new ObservationBuilder().build({
        call: contentCall,
        raw: contentRaw,
      });
      expect(contentObservation.displayText).toBe("a.ts:1:foo");

      const noMatchCall = tooling.testRuntime.toolCall({
        providerToolCallId: "call_2",
        name: "Grep",
        args: { pattern: "missing", output_mode: "content" },
      });
      const noMatchRaw = await tooling.runtime.execute(noMatchCall);
      const noMatchObservation = new ObservationBuilder().build({
        call: noMatchCall,
        raw: noMatchRaw,
      });
      expect(noMatchObservation.displayText).toBe("No matches found");

      const countCall = tooling.testRuntime.toolCall({
        providerToolCallId: "call_3",
        name: "Grep",
        args: { pattern: "foo", output_mode: "count" },
      });
      const countRaw = await tooling.runtime.execute(countCall);
      const countObservation = new ObservationBuilder().build({
        call: countCall,
        raw: countRaw,
      });
      expect(countObservation.displayText).toBe(
        "a.ts:1\nb.ts:3\n\nFound 4 total occurrences across 2 files.",
      );
    });
  });

  test("renders pagination info in observations", async () => {
    await withGrepWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.ts"), "foo\n", "utf8");
      await writeFile(path.join(workspace, "b.ts"), "foo\n", "utf8");
      await writeFile(path.join(workspace, "c.ts"), "foo\n", "utf8");

      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const call = tooling.testRuntime.toolCall({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo", head_limit: 1, offset: 1 },
      });
      const raw = await tooling.runtime.execute(call);
      const observation = new ObservationBuilder().build({ call, raw });

      expect(observation.displayText).toContain("Found 1 file\nb.ts");
      expect(observation.displayText).toContain(
        "[Showing results with pagination = limit: 1, offset: 1]",
      );
    });
  });

  test("renders failure observations with the pattern", async () => {
    await withGrepWorkspace(async (workspace) => {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const call = tooling.testRuntime.toolCall({
        providerToolCallId: "call_1",
        name: "Grep",
        args: { pattern: "foo", path: "../outside" },
      });
      const raw = await tooling.runtime.execute(call);
      const observation = new ObservationBuilder().build({ call, raw });

      expect(observation.displayText).toBe(
        'Grep failed for pattern="foo": Path escapes workspace.',
      );
    });
  });
});
