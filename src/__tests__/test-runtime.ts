import type { RuntimeSessionContext } from "../agent/runtime-session";
import type {
  IterationIdentity,
  ToolCall,
  ToolCallIdentity,
  TurnIdentity,
} from "../agent/types";
import type { EventSink } from "../events/event-sink";
import type { AgentEvent } from "../events/types";
import type {
  ModelClient,
  ModelRequestInput,
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
  PreparedPromptSegment,
} from "../model/model-client";
import {
  deriveModelContextBudget,
  type ModelContextProfile,
} from "../model/model-context-profile";
import { sha256, stableJsonStringify } from "../model/model-request-preflight";
import { estimatePromptSegments } from "../model/token-estimator";
import type { AssistantMessage } from "../agent/types";
import { ContextMeter } from "../agent/context-meter";
import {
  runtimeIdFactory,
  type ContextSurfaceId,
  type IterationId,
  type MessageId,
  type ProtocolFrameId,
  type ContextRevisionId,
  type RuntimeIdFactory,
  type SessionId,
  type ToolCallId,
  type TurnId,
} from "../ids/runtime-id";
import { createContextSurface } from "../context/context-surface";
import { CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION } from "../context/recall-retirement-contract";
import {
  createSessionCompatibilityContract,
  type SessionStore,
} from "../session/session-store";
import type { ProjectInstructionManifest } from "../instructions/project-instructions";
import type { ToolDefinition } from "../tools/types";
import type { ImageAttachmentId } from "../image/image-types";
import {
  RecallHistoryError,
  type SessionHistoryReader,
} from "../session/session-history-reader";

export const TEST_CONTEXT_PROFILE: ModelContextProfile = {
  contextWindowTokens: 256 * 1_024,
  maxSupportedOutputTokens: 64 * 1_024,
};

export const TEST_CONTEXT_BUDGET = deriveModelContextBudget(TEST_CONTEXT_PROFILE);

export function finalizeTestSessionStore(
  store: SessionStore,
  input: {
    systemPrompt: string;
    modelName?: string;
    profileName?: string;
    includeReasoningContent?: boolean;
    projectInstruction?: ProjectInstructionManifest;
    tools?: readonly ToolDefinition[];
    modelClient?: Pick<
      ModelClient,
      "messageProtocol" | "prepare" | "inputModalities" | "toolResultModalities"
    >;
  },
): void {
  const modelName = input.modelName ?? "test-model";
  const tools = input.tools ?? [];
  const requestInput: ModelRequestInput = {
    messages: [{ role: "system", content: input.systemPrompt }],
    tools: [...tools],
  };
  const prepared =
    input.modelClient?.prepare(requestInput) ?? prepareTestModelRequest(requestInput);
  const surface = createContextSurface({
    surfaceId: runtimeIdFactory.createContextSurfaceId(),
    sessionId: store.sessionId,
    systemPrompt: input.systemPrompt,
    recallContractVersion: CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION,
    ...(input.projectInstruction === undefined
      ? {}
      : { projectInstruction: input.projectInstruction }),
    toolDefinitions: tools,
    prepared,
    createdAt: new Date().toISOString(),
  });
  store.finalizeInitialization({
    contract: createSessionCompatibilityContract({
      modelName,
      ...(input.profileName === undefined ? {} : { profileName: input.profileName }),
      includeReasoningContent: input.includeReasoningContent === true,
      contextProfile: TEST_CONTEXT_PROFILE,
      messageProtocol: input.modelClient?.messageProtocol ?? {
        adapter: "fake",
        serializationVersion: "test-model-v1",
      },
      inputModalities: input.modelClient?.inputModalities ?? ["text"],
      toolResultModalities: input.modelClient?.toolResultModalities ?? ["text"],
    }),
    surface,
    revisionId: runtimeIdFactory.createContextRevisionId(),
  });
}

export function createTestHistoryReader(sessionId: SessionId): SessionHistoryReader {
  return Object.freeze({
    sessionId,
    search() {
      throw new RecallHistoryError(
        "RECALL_SOURCE_NOT_FOUND",
        "Test history reader has no messages.",
      );
    },
    get() {
      throw new RecallHistoryError(
        "RECALL_SOURCE_NOT_FOUND",
        "Test history reader has no messages.",
      );
    },
  });
}

const preparedInputs = new WeakMap<object, ModelRequestInput>();

export abstract class TestModelClient implements ModelClient {
  readonly inputModalities = Object.freeze(["text"] as const);
  readonly toolResultModalities = Object.freeze(["text"] as const);
  readonly messageProtocol = Object.freeze({
    adapter: "fake" as const,
    serializationVersion: "test-model-v1",
  });

  prepare(input: ModelRequestInput): PreparedModelRequest {
    return prepareTestModelRequest(input);
  }

  abstract request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput>;
}

export function createTestContextMeter(): ContextMeter {
  return new ContextMeter(TEST_CONTEXT_BUDGET);
}

export function prepareTestModelRequest(
  input: ModelRequestInput,
): PreparedModelRequest {
  const toolSegments = input.tools.map(
    (tool): PreparedPromptSegment => ({
      kind: "tool_schema",
      normalizedText: stableJsonStringify(tool),
    }),
  );
  const messageSegments = input.messages.map(testPromptSegment);
  const requestConfigHash = sha256("test-model-request-v1");
  const prepared: PreparedModelRequest = {
    provider: "test",
    model: "test-model",
    payload: input,
    promptSegments: [...toolSegments, ...messageSegments],
    requestConfigHash,
    toolSchemaHash: sha256(
      toolSegments.map((segment) => segment.normalizedText).join("\n"),
    ),
    requestMaxOutputTokens: TEST_CONTEXT_BUDGET.requestMaxOutputTokens,
    mediaOccurrenceCount: 0,
    assistantReplaySegments: (message) => [testPromptSegment(message)],
  };
  preparedInputs.set(prepared, {
    messages: [...input.messages],
    tools: [...input.tools],
    ...(input.responseFormat === undefined
      ? {}
      : { responseFormat: input.responseFormat }),
  });
  return prepared;
}

export function testModelRequestInput(
  prepared: PreparedModelRequest,
): ModelRequestInput {
  const input = preparedInputs.get(prepared);
  if (input === undefined) {
    throw new Error("Unknown prepared test model request.");
  }
  return input;
}

export function testModelOutput(
  prepared: PreparedModelRequest,
  message: AssistantMessage,
  finishReason?: string,
): ModelRequestOutput {
  const promptTokens = estimatePromptSegments(prepared.promptSegments).totalTokens;
  const completionTokens = Math.max(
    1,
    estimatePromptSegments(prepared.assistantReplaySegments(message)).totalTokens,
  );
  return {
    message,
    ...(finishReason === undefined ? {} : { finishReason }),
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
  };
}

export function createTestRuntime(eventSink: EventSink = collectingEventSink()) {
  const idFactory = deterministicIdFactory();
  const sessionId = idFactory.createSessionId();
  const turn: TurnIdentity = {
    sessionId,
    turnId: idFactory.createTurnId(),
    turnNumber: 1,
  };
  const iteration: IterationIdentity = {
    ...turn,
    iterationId: idFactory.createIterationId(),
    iterationNumber: 1,
  };
  let eventSequence = 0;
  let nextIterationNumber = 1;
  let nextToolCallNumber = 1;
  const knownIterations = new Map<string, IterationIdentity>([
    [iteration.iterationId, iteration],
  ]);

  const runtimeSession: RuntimeSessionContext = {
    sessionId,
    contextMaintenance: {
      async status() {
        throw new Error("Test runtime has no context maintenance coordinator.");
      },
      async candidates() {
        throw new Error("Test runtime has no context maintenance coordinator.");
      },
      async swap() {
        throw new Error("Test runtime has no context maintenance coordinator.");
      },
    },
    createIteration(inputTurn, iterationNumber) {
      if (
        inputTurn.sessionId !== turn.sessionId ||
        inputTurn.turnId !== turn.turnId ||
        inputTurn.turnNumber !== turn.turnNumber
      ) {
        throw new Error(`Unknown or mismatched turn identity: ${inputTurn.turnId}.`);
      }
      if (iterationNumber !== nextIterationNumber) {
        throw new Error(
          `iterationNumber must be ${nextIterationNumber}; received ${iterationNumber}.`,
        );
      }
      if (iterationNumber === 1) {
        nextIterationNumber = 2;
        return iteration;
      }
      const identity: IterationIdentity = {
        ...turn,
        iterationId: idFactory.createIterationId(),
        iterationNumber,
      };
      nextIterationNumber += 1;
      nextToolCallNumber = 1;
      knownIterations.set(identity.iterationId, identity);
      return identity;
    },
    createToolCall(inputIteration, toolCallNumber): ToolCallIdentity {
      if (!knownIterations.has(inputIteration.iterationId)) {
        throw new Error(
          `Unknown or mismatched iteration identity: ${inputIteration.iterationId}.`,
        );
      }
      if (toolCallNumber !== nextToolCallNumber) {
        throw new Error(
          `toolCallNumber must be ${nextToolCallNumber}; received ${toolCallNumber}.`,
        );
      }
      nextToolCallNumber += 1;
      return {
        ...inputIteration,
        toolCallId: idFactory.createToolCallId(),
        toolCallNumber,
      };
    },
    finishIterationForContinuation(inputIteration) {
      if (!knownIterations.has(inputIteration.iterationId)) {
        throw new Error(
          `Unknown or mismatched iteration identity: ${inputIteration.iterationId}.`,
        );
      }
    },
    async append(input) {
      eventSequence += 1;
      await eventSink.append({
        ...input,
        eventSequence,
        timestamp: new Date().toISOString(),
      } as AgentEvent);
    },
  };

  return {
    runtimeSession,
    turn,
    iteration,
    toolCall(input: TestToolCallInput): ToolCall {
      const identity = runtimeSession.createToolCall(iteration, nextToolCallNumber);
      return {
        ...identity,
        providerToolCallId:
          input.providerToolCallId ?? `provider-call-${identity.toolCallNumber}`,
        name: input.name,
        args: input.args,
        rawArgs: input.rawArgs,
        argsParseError: input.argsParseError,
      };
    },
  };
}

export type TestToolCallInput = {
  providerToolCallId?: string;
  name: string;
  args: unknown;
  rawArgs?: string;
  argsParseError?: string;
};

export function collectingEventSink(): EventSink & { events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return {
    events,
    async append(event) {
      events.push(event);
    },
  };
}

export function deterministicIdFactory(prefix = "test"): RuntimeIdFactory {
  let session = 0;
  let turn = 0;
  let iteration = 0;
  let toolCall = 0;
  let message = 0;
  let frame = 0;
  let revision = 0;
  let surface = 0;
  let imageAttachment = 0;
  return {
    createSessionId: () => `${prefix}-session-${++session}` as SessionId,
    createTurnId: () => `${prefix}-turn-${++turn}` as TurnId,
    createIterationId: () => `${prefix}-iteration-${++iteration}` as IterationId,
    createToolCallId: () => `${prefix}-tool-call-${++toolCall}` as ToolCallId,
    createMessageId: () => `${prefix}-message-${++message}` as MessageId,
    createProtocolFrameId: () => `${prefix}-frame-${++frame}` as ProtocolFrameId,
    createContextRevisionId: () =>
      `${prefix}-revision-${++revision}` as ContextRevisionId,
    createContextSurfaceId: () => `${prefix}-surface-${++surface}` as ContextSurfaceId,
    createImageAttachmentId: () =>
      `00000000-0000-7000-8000-${String(++imageAttachment).padStart(12, "0")}` as ImageAttachmentId,
  };
}

function testPromptSegment(
  message: ModelRequestInput["messages"][number],
): PreparedPromptSegment {
  return {
    kind:
      message.role === "system"
        ? "kernel"
        : message.role === "user"
          ? "user"
          : message.role,
    normalizedText: stableJsonStringify(message),
  };
}
