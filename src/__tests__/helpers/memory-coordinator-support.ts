import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionId, TurnId } from "../../ids/runtime-id";
import type { MemoryEmbeddingClient } from "../../memory/embedding-client";
import { resolveMemoryPaths } from "../../memory/memory-store";
import type {
  ModelRequestInput,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../../model/model-client";
import type { CompletedTurnSnapshot } from "../../session/session-store";
import {
  TestModelClient,
  testModelOutput,
  testModelRequestInput,
} from "../test-runtime";

export const EMBEDDING = Object.freeze({
  name: "coordinator-test-space",
  kind: "openai-compatible" as const,
  model: "coordinator-embedding",
  apiBase: "https://embedding.example.test/v1",
  apiKey: "embedding-key",
  dimensions: 3,
});

export class QueueExtractionModel extends TestModelClient {
  readonly inputs: ModelRequestInput[] = [];

  constructor(private readonly outputs: string[]) {
    super();
  }

  async request(prepared: PreparedModelRequest): Promise<ModelRequestOutput> {
    this.inputs.push(testModelRequestInput(prepared));
    const output = this.outputs.shift();
    if (output === undefined) {
      throw new Error("No extraction response is queued.");
    }
    return testModelOutput(prepared, {
      role: "assistant",
      content: output,
    });
  }
}

export class RecordingEmbeddingClient implements MemoryEmbeddingClient {
  readonly calls: string[][] = [];

  constructor(
    private readonly vectorFor: (input: string) => readonly number[] = () => [1, 0, 0],
  ) {}

  async embed(
    inputs: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly (readonly number[])[]> {
    signal.throwIfAborted();
    this.calls.push([...inputs]);
    return Object.freeze(
      inputs.map((input) => Object.freeze([...this.vectorFor(input)])),
    );
  }
}

export class SelectiveFailureEmbeddingClient extends RecordingEmbeddingClient {
  async embed(
    inputs: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly (readonly number[])[]> {
    if (inputs.length === 1 && inputs[0] === "provider failure") {
      this.calls.push([...inputs]);
      throw new Error("embedding endpoint unavailable");
    }
    return super.embed(inputs, signal);
  }
}

export function completedSnapshot(userContent: string): CompletedTurnSnapshot {
  return Object.freeze({
    messages: Object.freeze([
      Object.freeze({
        ordinal: 2,
        role: "user" as const,
        content: userContent,
      }),
      Object.freeze({
        ordinal: 3,
        role: "assistant" as const,
        content: "assistant content",
        reasoningContent: "assistant reasoning",
      }),
      Object.freeze({
        ordinal: 4,
        role: "tool" as const,
        name: "MemorySearch",
        content: "old derived memory",
      }),
      Object.freeze({
        ordinal: 5,
        role: "tool" as const,
        name: "MemoryGet",
        content: "old derived memory full record",
      }),
      Object.freeze({
        ordinal: 6,
        role: "tool" as const,
        name: "MemoryCreate",
        content: "new derived memory",
      }),
      Object.freeze({
        ordinal: 7,
        role: "tool" as const,
        name: "MemoryUpdate",
        content: "updated derived memory",
      }),
      Object.freeze({
        ordinal: 8,
        role: "tool" as const,
        name: "MemoryDelete",
        content: "deleted derived memory",
      }),
      Object.freeze({
        ordinal: 9,
        role: "tool" as const,
        name: "Read",
        content: "Read succeeded with verified output.",
      }),
    ]),
  });
}

export async function createFixture() {
  const homeRoot = await mkdtemp(path.join(os.tmpdir(), "tinker-memory-coordinator-"));
  return {
    homeRoot,
    paths: resolveMemoryPaths(homeRoot),
    workspaceRoot: path.join(homeRoot, "workspace"),
    sessionId: "coordinator-session" as SessionId,
    cleanup: () => rm(homeRoot, { recursive: true }),
  };
}

export function completedHookInput(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  content: string,
  turnId: string,
) {
  return {
    workspaceRoot: fixture.workspaceRoot,
    sessionId: fixture.sessionId,
    turnId: turnId as TurnId,
    snapshot: completedSnapshot(content),
  };
}

export async function waitForLogKind(
  filePath: string,
  kind: string,
): Promise<Record<string, unknown>[]> {
  return waitFor(async () => {
    const diagnostics = await readDiagnostics(filePath);
    return diagnostics.some((entry) => entry.kind === kind) ? diagnostics : undefined;
  });
}

export async function waitForLogLines(
  filePath: string,
  count: number,
): Promise<Record<string, unknown>[]> {
  return waitFor(async () => {
    const diagnostics = await readDiagnostics(filePath);
    return diagnostics.length >= count ? diagnostics : undefined;
  });
}

export async function readDiagnostics(
  filePath: string,
): Promise<Record<string, unknown>[]> {
  const content = await readOptionalFile(filePath);
  return content.trim() === ""
    ? []
    : content
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export async function readOptionalFile(filePath: string): Promise<string> {
  return readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
}

export async function waitFor<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for memory test state.");
}
