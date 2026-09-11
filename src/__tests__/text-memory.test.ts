import { expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  memoryDirectory,
  sessionMemoryPath,
  ensureMemoryDirectory,
} from "../memory/memory-files";
import { createDefaultTooling } from "./helpers/tools-support";
import { createRuntimeSession } from "../agent/runtime-session";
import { runtimeIdFactory } from "../ids/runtime-id";
import { SessionStore } from "../session/session-store";
import {
  TEST_CONTEXT_BUDGET,
  TEST_CONTEXT_PROFILE,
  TestModelClient,
  testModelOutput,
  testModelRequestInput,
} from "./test-runtime";
import type { PreparedModelRequest } from "../model/model-client";

async function fixture() {
  const homeRoot = await mkdtemp(path.join(os.tmpdir(), "tinker-text-memory-"));
  const workspaceRoot = path.join(homeRoot, "workspace");
  await mkdir(workspaceRoot);
  return {
    homeRoot,
    workspaceRoot,
    cleanup: () => rm(homeRoot, { recursive: true, force: true }),
  };
}

test("MemoryCreate writes Markdown; MemorySearch finds both sources and Read opens both sources", async () => {
  const f = await fixture();
  const tooling = createDefaultTooling(f);
  try {
    const searchSchema = tooling.registry
      .definitions()
      .find((tool) => tool.name === "MemorySearch")!;
    expect(Object.keys(searchSchema.parameters.properties as object)).toEqual([
      "keywords",
      "context",
      "limit",
      "offset",
    ]);
    const note = await tooling.runtime.execute({
      name: "MemoryCreate",
      args: { text: "发布 policy", summary: "Use AFTER_APPROVAL for releases." },
    });
    expect(note.kind).toBe("memory_create");
    if (note.kind !== "memory_create" || !note.ok || !note.filePath)
      throw new Error("note failed");
    expect(note.filePath).toStartWith(path.join(memoryDirectory(f.homeRoot), "notes"));
    expect(await readFile(note.filePath, "utf8")).toBe(
      `# 发布 policy\n\nCreated: ${note.createdAt}\nWorkspace: ${f.workspaceRoot}\n\nUse AFTER_APPROVAL for releases.\n`,
    );
    expect((await stat(note.filePath)).mode & 0o777).toBe(0o600);
    const record = sessionMemoryPath(runtimeIdFactory.createSessionId(), f.homeRoot);
    await mkdir(path.dirname(record), { recursive: true });
    await writeFile(record, "# Session\n\nUser: verify AFTER_APPROVAL\n");
    await writeFile(path.join(f.workspaceRoot, "outside.md"), "AFTER_APPROVAL");
    const args = { keywords: ["after_approval"], context: 1, limit: 1 };
    const memory = await tooling.runtime.execute({ name: "MemorySearch", args });
    expect(memory).toMatchObject({
      kind: "memory_search",
      ok: true,
      format: "text",
      hasMore: true,
      nextOffset: 1,
      files: [{ filePath: note.filePath }],
    });
    const second = await tooling.runtime.execute({
      name: "MemorySearch",
      args: { ...args, offset: 1 },
    });
    expect(second).toMatchObject({
      ok: true,
      files: [{ filePath: record }],
      hasMore: false,
    });
    const read = await tooling.runtime.execute({
      name: "Read",
      args: { file_path: note.filePath },
    });
    expect(read.ok).toBe(true);
    expect(JSON.stringify(read)).toContain("AFTER_APPROVAL");
    const duplicate = await tooling.runtime.execute({
      name: "MemoryCreate",
      args: { text: "发布 policy" },
    });
    expect(duplicate).toMatchObject({ ok: true, status: "created" });
    for (const args of [
      {},
      { text: " " },
      { text: "字".repeat(171) },
      { text: "ok", summary: "x".repeat(4097) },
      { text: "ok", extra: 1 },
    ]) {
      expect(
        await tooling.runtime.execute({ name: "MemoryCreate", args }),
      ).toMatchObject({ ok: false });
    }
    expect(await readdir(path.join(memoryDirectory(f.homeRoot), "notes"))).toHaveLength(
      2,
    );
  } finally {
    await tooling.dispose();
    await f.cleanup();
  }
});

class MemoryModel extends TestModelClient {
  async request(prepared: PreparedModelRequest) {
    expect(
      testModelRequestInput(prepared)
        .tools.map((tool) => tool.name)
        .filter((name) => name.startsWith("Memory")),
    ).toEqual(["MemorySearch", "MemoryCreate"]);
    return testModelOutput(prepared, {
      role: "assistant",
      content: "Remembered session answer",
    });
  }
}

test("session records append across resume, clones keep history, and session deletion retains memory", async () => {
  const f = await fixture();
  const sessionId = runtimeIdFactory.createSessionId();
  const cloneId = runtimeIdFactory.createSessionId();
  const common = {
    ...f,
    modelName: "test-model",
    maxIterations: 2,
    includeReasoningContent: false,
    contextProfile: TEST_CONTEXT_PROFILE,
    contextBudget: TEST_CONTEXT_BUDGET,
    modelClient: new MemoryModel(),
    systemPrompt: "system",
  };
  let session = await createRuntimeSession(
    { ...common, selection: { mode: "new", sessionId } },
    { loadMcpConfig: async () => undefined },
  );
  try {
    await session.executeTurn({
      userMessage: { role: "user", content: "first memory prompt" },
      signal: new AbortController().signal,
    });
    await session.cloneSession(cloneId);
    const before = await readFile(sessionMemoryPath(sessionId, f.homeRoot), "utf8");
    expect(before).toContain("first memory prompt");
    expect(await readFile(sessionMemoryPath(cloneId, f.homeRoot), "utf8")).toContain(
      "first memory prompt",
    );
    await session.dispose({ type: "tui_exit" });
    session = await createRuntimeSession(
      { ...common, selection: { mode: "resume", sessionId } },
      { loadMcpConfig: async () => undefined },
    );
    await session.executeTurn({
      userMessage: { role: "user", content: "second memory prompt" },
      signal: new AbortController().signal,
    });
    const after = await readFile(sessionMemoryPath(sessionId, f.homeRoot), "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain("second memory prompt");
    await session.dispose({ type: "tui_exit" });
    const store = await SessionStore.openExisting({
      workspaceRoot: f.workspaceRoot,
      homeRoot: f.homeRoot,
      sessionId,
    });
    await store.deleteFromDisk();
    expect(await readFile(sessionMemoryPath(sessionId, f.homeRoot), "utf8")).toBe(
      after,
    );
  } finally {
    await session.dispose({ type: "tui_exit" });
    await f.cleanup();
  }
});

test("legacy diagnostics and database are archived outside memory search", async () => {
  const f = await fixture();
  try {
    const directory = memoryDirectory(f.homeRoot);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "memory.sqlite"),
      "legacy database placeholder",
    );
    await writeFile(
      path.join(directory, "extracted-memories.log"),
      "legacy diagnostic",
    );
    await ensureMemoryDirectory(f.homeRoot);
    expect(await readdir(directory)).toEqual([]);
    const archiveRoot = path.join(f.homeRoot, ".tinker", "memory-legacy");
    const [archive] = await readdir(archiveRoot);
    expect(
      await readFile(path.join(archiveRoot, archive, "memory.sqlite"), "utf8"),
    ).toBe("legacy database placeholder");
  } finally {
    await f.cleanup();
  }
});
