import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createRuntimeSession,
  type CreateRuntimeSessionInput,
  type RuntimeSession,
} from "../../agent/runtime-session";
import { cancellationError } from "../../agent/turn-cancellation";
import type { EventSink } from "../../events/event-sink";
import { type SessionId } from "../../ids/runtime-id";
import type {
  ModelClient,
  ModelRequestInput,
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../../model/model-client";
import {
  deterministicIdFactory,
  TEST_CONTEXT_BUDGET,
  TEST_CONTEXT_PROFILE,
  TestModelClient,
  testModelOutput,
  testModelRequestInput,
} from "../test-runtime";

export class CapturingModel extends TestModelClient {
  readonly inputs: ModelRequestInput[] = [];

  async request(prepared: PreparedModelRequest): Promise<ModelRequestOutput> {
    const input = testModelRequestInput(prepared);
    this.inputs.push({ messages: [...input.messages], tools: [...input.tools] });
    return testModelOutput(prepared, {
      role: "assistant",
      content: `answer-${this.inputs.length}`,
    });
  }
}

export class WaitingModel extends TestModelClient {
  readonly started: Promise<void>;
  private markStarted!: () => void;

  constructor() {
    super();
    this.started = new Promise((resolve) => {
      this.markStarted = resolve;
    });
  }

  async request(
    _prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    this.markStarted();
    return new Promise((_resolve, reject) => {
      const abort = () => reject(cancellationError(options.signal));
      if (options.signal.aborted) {
        abort();
        return;
      }
      options.signal.addEventListener("abort", abort, { once: true });
    });
  }
}

export async function createTestSession(
  model: ModelClient,
  sink: EventSink,
  prefix: string,
): Promise<RuntimeSession> {
  return createRuntimeSession(createInput(model, sink, prefix), {
    idFactory: deterministicIdFactory(prefix),
    loadMcpConfig: async () => undefined,
  });
}

export function createInput(
  model: ModelClient,
  sink: EventSink,
  prefix: string,
): CreateRuntimeSessionInput {
  return {
    selection: {
      mode: "new",
      sessionId: `${prefix}-${crypto.randomUUID()}` as SessionId,
    },
    workspaceRoot: mkdtempSync(path.join(os.tmpdir(), "tinker-runtime-test-")),
    modelName: "test-model",
    maxIterations: 2,
    includeReasoningContent: false,
    contextProfile: TEST_CONTEXT_PROFILE,
    contextBudget: TEST_CONTEXT_BUDGET,
    systemPrompt: "system",
    modelClient: model,
    presentationSinks: [sink],
    persistence: false,
  };
}
