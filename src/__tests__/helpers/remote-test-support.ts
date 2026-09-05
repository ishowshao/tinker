import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRuntimeSession } from "../../agent/runtime-session";
import { parseSessionId } from "../../ids/runtime-id";
import { resolveSessionDatabasePath } from "../../session/session-store";
import { RemoteServiceStore } from "../../remote/service-store";
import { RemoteService } from "../../remote/service";
import type { RemoteOperationInput, OperationReceipt } from "../../remote/protocol";
import type { HostedRuntimeFactory } from "../../agent/runtime-hosted-session";
import type {
  ModelClient,
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../../model/model-client";
import {
  TEST_CONTEXT_BUDGET,
  TEST_CONTEXT_PROFILE,
  TestModelClient,
  testModelOutput,
} from "../test-runtime";

export async function remoteFixture(model: ModelClient) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "tinker-remote-test-")),
  );
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const store = await RemoteServiceStore.open(path.join(root, "service"));
  let factoryCalls = 0;
  const factory: HostedRuntimeFactory = async ({ record, sink }) => {
    factoryCalls += 1;
    const sessionId = parseSessionId(record.id);
    const runtime = await createRuntimeSession(
      {
        workspaceRoot: workspace,
        homeRoot: root,
        ...(record.initialized
          ? { selection: { mode: "resume" as const, sessionId } }
          : { selection: { mode: "new" as const, sessionId } }),
        modelName: "test-model",
        maxIterations: 10,
        includeReasoningContent: false,
        contextProfile: TEST_CONTEXT_PROFILE,
        contextBudget: TEST_CONTEXT_BUDGET,
        systemPrompt: "system",
        modelClient: model,
        presentationSinks: [sink],
        assistantTextDeltaSink: sink,
        persistence: false,
        enableAskUser: true,
        bashGuard: { mode: "guard", source: "default", surface: "tui" },
      },
      { loadMcpConfig: async () => undefined },
    );
    return {
      runtime,
      databasePath: await resolveSessionDatabasePath(workspace, sessionId, root),
      modelName: "test-model",
    };
  };
  const workspaces = [{ id: "test", name: "Test workspace", path: workspace }];
  const service = new RemoteService(store, workspaces, factory, root);
  const create = await service.submit(
    { kind: "create", workspaceId: "test", requestId: randomUUID() },
    "phone",
  );
  await service.session(create.sessionId).open();
  const sessionId = create.sessionId;
  return {
    root,
    workspace,
    store,
    service,
    sessionId,
    factory,
    workspaces,
    factoryCalls: () => factoryCalls,
    prompt: (prompt = "hello", requestId = randomUUID()) =>
      service.submit({ kind: "prompt", sessionId, requestId, prompt }, "phone"),
    submit: (
      input: Omit<RemoteOperationInput, "requestId"> & Record<string, unknown>,
    ) =>
      service.submit(
        { ...input, requestId: randomUUID() } as RemoteOperationInput,
        "phone",
      ),
    terminal: (receipt: OperationReceipt) =>
      until(() => {
        const current = store.get(receipt.requestId);
        return ["completed", "failed", "cancelled", "interrupted"].includes(
          current.status,
        )
          ? current
          : undefined;
      }),
    cleanup: async () => {
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function until<T>(
  read: () => T | undefined | false,
  timeout = 5000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for remote state.");
}

export class RemoteTestModel extends TestModelClient {
  requests = 0;
  aborted = false;
  private releaseGate!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });
  constructor(
    private readonly mode: "answer" | "question" | "confirmation" = "answer",
  ) {
    super();
  }
  release(): void {
    this.releaseGate();
  }
  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.requests += 1;
    options.onTextDelta?.("Provisional text");
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        this.aborted = true;
        reject(new Error("aborted"));
      };
      if (options.signal.aborted) {
        abort();
        return;
      }
      options.signal.addEventListener("abort", abort, { once: true });
      void this.gate.then(() => {
        options.signal.removeEventListener("abort", abort);
        resolve();
      });
    });
    if (this.requests === 1 && this.mode !== "answer") {
      const identity = options.identity!;
      return testModelOutput(prepared, {
        role: "assistant",
        content: "Need input",
        toolCalls: [
          {
            ...identity.runtimeSession.createToolCall(identity.iteration, 1),
            providerToolCallId: "remote-tool",
            name: this.mode === "question" ? "AskUser" : "Bash",
            args:
              this.mode === "question"
                ? {
                    question: "Which scope?",
                    options: [
                      { description: "Current project" },
                      { description: "All projects" },
                    ],
                  }
                : { command: "reboot" },
          },
        ],
      });
    }
    return testModelOutput(prepared, {
      role: "assistant",
      content: `Complete answer ${this.requests}`,
    });
  }
}
