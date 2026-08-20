import {
  materializeModelRequest,
  type MaterializedModelRequest,
  type ModelClient,
  type ModelRequestOutput,
  type PreparedModelRequest,
  ProviderResponseError,
} from "../model/model-client";
import type { ImageAssetStore } from "../image/image-asset-store";
import {
  CommittedPrefixAuditError,
  CommittedPrefixAuditor,
} from "../model/committed-prefix-auditor";
import type { ObservationBuilder } from "../observation/observation-builder";
import type { ToolRegistry, ToolRuntime } from "../tools/registry";
import { ToolExecutionFatalError } from "../tools/types";
import type { ContextMeter, ContextUsageSnapshot } from "./context-meter";
import type { RuntimeSessionContext } from "./runtime-session";
import type { AgentTurnLedger } from "./session-ledger";
import { ContextProtocolError } from "../context/context-protocol-validator";
import { CompiledContextError } from "../context/compiled-context-validator";
import { ContextRevisionError } from "../context/context-revision-compiler";
import type { BuiltContextRequest } from "../context/context-revision";
import { swapOnlyPolicyV1 } from "../context/context-policy";
import {
  SwapPlanningDiagnosticError,
  type SwapPlanningResult,
  type SwapPlanningTrigger,
  type SwapPlanner,
} from "../context/swap-planner";
import { SessionError } from "../session/session-errors";
import { stableJsonStringify } from "../model/model-request-preflight";
import {
  normalizeSyntheticDetail,
  type SyntheticToolCompletionInput,
} from "../context/protocol-frame";
import { throwIfTurnCancelled, turnCancellationSource } from "./turn-cancellation";
import type {
  IterationIdentity,
  RunAgentResult,
  ToolCall,
  TurnCancellation,
  TurnIdentity,
} from "./types";

export type RunAgentInput = {
  ledger: AgentTurnLedger;
  maxIterations: number;
  model: ModelClient;
  contextMeter: ContextMeter;
  committedPrefixAuditor?: CommittedPrefixAuditor;
  shadowPlanning?: {
    planner: SwapPlanner;
    select(input: {
      built: BuiltContextRequest;
      preflight: ReturnType<ContextMeter["measure"]>;
    }):
      | {
          trigger: Exclude<SwapPlanningTrigger, "manual">;
          forcedTargetTokens?: number;
        }
      | undefined;
    onResult?(result: SwapPlanningResult, built: BuiltContextRequest): void;
  };
  tools: ToolRegistry;
  toolRuntime: ToolRuntime;
  observationBuilder: ObservationBuilder;
  runtimeSession: RuntimeSessionContext;
  turn: TurnIdentity;
  signal: AbortSignal;
  assetStore?: ImageAssetStore;
  initialRequest?: {
    prepared: MaterializedModelRequest;
    usage: ContextUsageSnapshot;
  };
  transientRetryDelaysMs?: readonly number[];
};

export class FatalAgentTurnError extends Error {
  constructor(
    readonly result: Extract<RunAgentResult, { status: "failed" }>,
    options?: ErrorOptions,
  ) {
    super(result.error, options);
    this.name = "FatalAgentTurnError";
  }
}

const REASONING_ONLY_RETRY_LIMIT = 1 as const;
const TRANSIENT_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000] as const;
const MODEL_REQUEST_MAX_ATTEMPTS =
  1 + REASONING_ONLY_RETRY_LIMIT + TRANSIENT_RETRY_DELAYS_MS.length;

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  let lastIteration: IterationIdentity | undefined;
  let consumedThroughOrdinal = 1;
  const committedPrefixAuditor =
    input.committedPrefixAuditor ?? new CommittedPrefixAuditor();

  for (
    let iterationNumber = 1;
    iterationNumber <= input.maxIterations;
    iterationNumber += 1
  ) {
    const iteration = input.runtimeSession.createIteration(input.turn, iterationNumber);
    lastIteration = iteration;
    await input.runtimeSession.append({
      type: "agent.iteration.started",
      ...iteration,
      data: { iterationNumber },
    });

    if (input.signal.aborted) {
      return cancelledResult(
        cancellation(input.signal, iteration, "agent_boundary"),
        iteration,
      );
    }

    let prepared: PreparedModelRequest;
    let request: PreparedModelRequest;
    let built: BuiltContextRequest;
    let preflight;
    try {
      throwIfTurnCancelled(input.signal);
      built = input.ledger.buildModelRequest(input.tools.definitions());
      const admission = iterationNumber === 1 ? input.initialRequest : undefined;
      const candidate = input.model.prepare(built.request);
      if (admission !== undefined && !samePreparedPlan(candidate, admission.prepared)) {
        throw new Error("Accepted request no longer matches the first dispatch plan.");
      }
      prepared = admission?.prepared ?? candidate;
      committedPrefixAuditor.audit(built.compiled.revisionId, prepared);
      preflight = admission?.usage ?? input.contextMeter.measure(prepared);
    } catch (error) {
      if (input.signal.aborted) {
        return cancelledResult(
          cancellation(input.signal, iteration, "agent_boundary"),
          iteration,
        );
      }
      if (isCanonicalContextFailure(error)) {
        throw error;
      }
      return failedResult(error, iteration);
    }
    await input.runtimeSession.append({
      type: "context.usage.updated",
      ...iteration,
      data: { phase: "preflight", snapshot: preflight },
    });
    await runShadowPlanning({
      input,
      iteration,
      built,
      prepared,
      preflight,
      consumedThroughOrdinal,
    });
    try {
      input.contextMeter.assertWithinBudget(preflight);
    } catch (error) {
      return failedResult(error, iteration);
    }

    try {
      if (prepared.mediaOccurrenceCount > 0) {
        if (input.initialRequest?.prepared === prepared) {
          request = prepared;
        } else {
          if (input.assetStore === undefined) {
            throw new Error("Image model request has no asset store.");
          }
          request = await materializeModelRequest(input.model, prepared, {
            assetStore: input.assetStore,
            signal: input.signal,
          });
          preflight = input.contextMeter.measure(request);
          input.contextMeter.assertWithinBudget(preflight);
          await input.runtimeSession.append({
            type: "context.usage.updated",
            ...iteration,
            data: { phase: "preflight", snapshot: preflight },
          });
        }
      } else {
        request = prepared;
      }
    } catch (error) {
      if (input.signal.aborted) {
        return cancelledResult(
          cancellation(input.signal, iteration, "model_request"),
          iteration,
        );
      }
      return failedResult(error, iteration);
    }

    await input.runtimeSession.append({
      type: "model.request.started",
      ...iteration,
      data: {
        attemptNumber: 1,
        maxAttempts: MODEL_REQUEST_MAX_ATTEMPTS,
      },
    });

    try {
      throwIfTurnCancelled(input.signal);
      input.runtimeSession.prepareModelDispatch?.({ iteration, built });
    } catch (error) {
      if (input.signal.aborted) {
        return cancelledResult(
          cancellation(input.signal, iteration, "model_request"),
          iteration,
        );
      }

      return failedResult(error, iteration);
    }

    const transientRetryDelaysMs =
      input.transientRetryDelaysMs ?? TRANSIENT_RETRY_DELAYS_MS;
    let modelOutput: ModelRequestOutput | undefined;
    let successfulAttempt: number | undefined;
    let attemptNumber = 0;
    let reasoningOnlyRetries = 0;
    let transientRetries = 0;
    while (true) {
      if (input.signal.aborted) {
        return cancelledResult(
          cancellation(input.signal, iteration, "model_request"),
          iteration,
        );
      }
      attemptNumber += 1;
      if (attemptNumber > 1) {
        await input.runtimeSession.append({
          type: "model.request.started",
          ...iteration,
          data: {
            attemptNumber,
            maxAttempts: MODEL_REQUEST_MAX_ATTEMPTS,
          },
        });
      }

      try {
        throwIfTurnCancelled(input.signal);
        let acceptingTextDeltas = true;
        const onTextDelta =
          input.runtimeSession.updateAssistantTextDelta === undefined
            ? undefined
            : (content: string) => {
                if (!acceptingTextDeltas || input.signal.aborted) {
                  return;
                }
                input.runtimeSession.updateAssistantTextDelta?.({
                  ...iteration,
                  attemptNumber,
                  content,
                });
              };
        try {
          modelOutput = await input.model.request(request, {
            signal: input.signal,
            identity: {
              iteration,
              runtimeSession: input.runtimeSession,
            },
            ...(onTextDelta === undefined ? {} : { onTextDelta }),
          });
        } finally {
          acceptingTextDeltas = false;
        }
        throwIfTurnCancelled(input.signal);
        successfulAttempt = attemptNumber;
        break;
      } catch (error) {
        if (input.signal.aborted) {
          return cancelledResult(
            cancellation(input.signal, iteration, "model_request"),
            iteration,
          );
        }

        const decision = modelRequestRetryDecision(error, {
          reasoningOnlyRetries,
          transientRetries,
          transientRetryDelaysMs,
        });
        await input.runtimeSession.append({
          type: "model.request.failed",
          ...iteration,
          data: modelRequestFailureData({
            error,
            request,
            attemptNumber,
            retryDisposition: decision.disposition,
            ...(decision.disposition === "scheduled" && decision.delayMs > 0
              ? { retryDelayMs: decision.delayMs }
              : {}),
          }),
        });

        if (decision.disposition === "scheduled") {
          if (decision.kind === "reasoning_only") {
            reasoningOnlyRetries += 1;
          } else {
            transientRetries += 1;
            await waitForRetryDelay(decision.delayMs, input.signal);
          }
          continue;
        }
        if (
          decision.disposition === "exhausted" &&
          decision.kind === "reasoning_only"
        ) {
          return failedResult(
            new Error(
              `Provider returned reasoning without final text or tool calls in both attempts (provider=${request.provider}, model=${request.model}).`,
            ),
            iteration,
          );
        }
        return failedResult(error, iteration);
      }
    }
    if (modelOutput === undefined || successfulAttempt === undefined) {
      throw new Error("Model request attempt state completed without an output.");
    }

    try {
      input.ledger.appendAssistant({
        iteration,
        message: modelOutput.message,
        provider: request.provider,
        model: request.model,
      });
    } catch (error) {
      if (error instanceof ContextProtocolError) {
        return failedResult(error, iteration);
      }
      throw error;
    }

    await input.runtimeSession.append({
      type: "model.request.finished",
      ...iteration,
      data: {
        attemptNumber: successfulAttempt,
        maxAttempts: MODEL_REQUEST_MAX_ATTEMPTS,
        output: modelOutput,
      },
    });
    const measured = input.contextMeter.recordProviderUsage(request, modelOutput);
    consumedThroughOrdinal = built.canonical.messages.length;
    await input.runtimeSession.append({
      type: "context.usage.updated",
      ...iteration,
      data: { phase: "measured", snapshot: measured },
    });

    const toolCalls = modelOutput.message.toolCalls ?? [];
    if (toolCalls.length === 0) {
      await input.runtimeSession.append({
        type: "agent.iteration.finished",
        ...iteration,
        data: { outcome: "completed", toolCallCount: 0 },
      });
      return {
        status: "completed",
        finalText: modelOutput.message.content ?? "",
        lastIteration: iteration,
      };
    }

    const progressContent = modelOutput.message.content?.trim();
    if (progressContent !== undefined && progressContent !== "") {
      await input.runtimeSession.append({
        type: "assistant.progress",
        ...iteration,
        data: { content: progressContent },
      });
    }

    for (let callIndex = 0; callIndex < toolCalls.length; callIndex += 1) {
      const call = requireToolCall(toolCalls, callIndex);
      requireCallInIteration(call, iteration, callIndex + 1);

      if (input.signal.aborted) {
        input.ledger.commitToolCompletions(
          cancelledToolCompletions(toolCalls, callIndex),
        );
        return cancelledResult(
          cancellation(input.signal, iteration, "agent_boundary"),
          iteration,
        );
      }

      input.ledger.assertCanExecuteTool(call);

      await input.runtimeSession.append({
        type: "tool.started",
        ...call,
        data: { call },
      });

      let raw;
      try {
        raw = await input.toolRuntime.execute(call, { signal: input.signal });
      } catch (error) {
        if (!input.signal.aborted) {
          input.ledger.commitToolCompletions(
            failedToolCompletions(toolCalls, callIndex, error),
          );
          const result = failedResult(error, iteration);
          if (error instanceof ToolExecutionFatalError) {
            throw new FatalAgentTurnError(result, { cause: error });
          }
          return result;
        }

        input.ledger.commitToolCompletions(
          cancelledToolCompletions(toolCalls, callIndex, call),
        );
        return cancelledResult(
          cancellation(input.signal, iteration, "tool_execution", call),
          iteration,
        );
      }

      const observation = input.observationBuilder.build({ call, raw });
      const completions = [
        {
          call,
          kind: "returned",
          raw,
          observation: observation.content,
        },
      ] as const;
      const committed = input.ledger.commitToolCompletions(completions);
      if (
        raw.kind === "skill" &&
        raw.ok &&
        raw.status === "loaded" &&
        input.runtimeSession.onToolCompletionsCommitted === undefined
      ) {
        throw new Error(
          "Loaded Agent Skill completion has no runtime activation coordinator.",
        );
      }
      input.runtimeSession.onToolCompletionsCommitted?.({
        completions,
        committed,
      });

      await input.runtimeSession.append({
        type: "tool.raw_result",
        ...call,
        data: { call, raw },
      });
      await input.runtimeSession.append({
        type: "tool.finished",
        ...call,
        data: { call, ok: raw.ok },
      });

      await input.runtimeSession.append({
        type: "tool.observation",
        ...call,
        data: { call, observation },
      });

      if (input.signal.aborted) {
        if (callIndex + 1 < toolCalls.length) {
          input.ledger.commitToolCompletions(
            cancelledToolCompletions(toolCalls, callIndex + 1),
          );
        }
        return cancelledResult(
          cancellation(input.signal, iteration, "agent_boundary"),
          iteration,
        );
      }
    }

    await input.runtimeSession.applyQueuedSteering?.({
      turn: input.turn,
      ledger: input.ledger,
    });
    await input.runtimeSession.append({
      type: "agent.iteration.finished",
      ...iteration,
      data: { outcome: "continue", toolCallCount: toolCalls.length },
    });
    input.runtimeSession.finishIterationForContinuation(iteration);
    await input.runtimeSession.maintainContextAfterIteration?.({
      turn: input.turn,
      consumedThroughOrdinal,
      ledger: input.ledger,
    });
  }

  if (lastIteration === undefined) {
    throw new Error("Agent loop did not create an iteration identity.");
  }

  return {
    status: "failed",
    error: `Agent turn ${input.turn.turnId} stopped after maxIterations=${input.maxIterations}; last iteration=${lastIteration.iterationId}`,
    lastIteration,
  };
}

async function runShadowPlanning(input: {
  input: RunAgentInput;
  iteration: IterationIdentity;
  built: BuiltContextRequest;
  prepared: PreparedModelRequest;
  preflight: ReturnType<ContextMeter["measure"]>;
  consumedThroughOrdinal: number;
}): Promise<void> {
  const shadowPlanning = input.input.shadowPlanning;
  if (shadowPlanning === undefined) {
    return;
  }
  const decision = shadowPlanning.select({
    built: input.built,
    preflight: input.preflight,
  });
  if (decision === undefined) {
    return;
  }

  const startedAt = performance.now();
  let result: SwapPlanningResult;
  try {
    result = shadowPlanning.planner.plan({
      active: input.built.compiled,
      revision: input.built.revision,
      surface: input.built.surface,
      activeOverrides: input.built.activeOverrides,
      canonical: input.built.canonical,
      activePrepared: input.prepared,
      activeUsage: input.preflight,
      tools: input.input.tools.definitions(),
      policy: swapOnlyPolicyV1,
      trigger: decision.trigger,
      activeTurn: {
        turnId: input.input.turn.turnId,
        consumedThroughOrdinal: input.consumedThroughOrdinal,
      },
      ...(decision.forcedTargetTokens === undefined
        ? {}
        : { forcedTargetTokens: decision.forcedTargetTokens }),
    });
  } catch (error) {
    if (isCanonicalContextFailure(error)) {
      throw error;
    }
    const failure =
      error instanceof SwapPlanningDiagnosticError
        ? error
        : new SwapPlanningDiagnosticError(
            "validate",
            "unexpected_shadow_failure",
            "Shadow planning failed without changing the active request.",
          );
    await input.input.runtimeSession.append({
      type: "context.shadow.failed",
      ...input.iteration,
      data: {
        policyVersion: "swap-only-v1",
        stage: failure.stage,
        errorCode: failure.code,
        error: failure.message,
      },
    });
    return;
  }
  shadowPlanning.onResult?.(result, input.built);

  await input.input.runtimeSession.append({
    type: "context.shadow.planned",
    ...input.iteration,
    data: {
      policyVersion: "swap-only-v1",
      trigger: decision.trigger,
      outcome: result.outcome,
      canonicalMessageCount: result.canonicalMessageCount,
      eligibleCandidateCount: result.eligibleCandidateCount,
      selectedCandidateCount: result.plan?.addedOverrides.length ?? 0,
      excludedByReason: { ...result.excludedByReason },
      selectedByRawKind: { ...result.selectedByRawKind },
      originalObservationBytes: result.originalObservationBytes,
      projectedObservationBytes: result.projectedObservationBytes,
      rawTokensBefore: result.rawTokensBefore,
      ...(result.plan === undefined
        ? {}
        : {
            rawTokensAfter: result.plan.rawTokensAfter,
            guardedTokensAfter: result.plan.guardedTokensAfter,
            planHash: result.plan.planHash,
          }),
      guardedTokensBefore: result.guardedTokensBefore,
      targetTokens: result.targetTokens,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    },
  });
}

function isCanonicalContextFailure(error: unknown): boolean {
  return (
    error instanceof ContextProtocolError ||
    error instanceof ContextRevisionError ||
    error instanceof CompiledContextError ||
    error instanceof CommittedPrefixAuditError ||
    error instanceof SessionError
  );
}

function samePreparedPlan(
  candidate: PreparedModelRequest,
  accepted: PreparedModelRequest,
): boolean {
  return (
    candidate.provider === accepted.provider &&
    candidate.model === accepted.model &&
    candidate.requestConfigHash === accepted.requestConfigHash &&
    candidate.toolSchemaHash === accepted.toolSchemaHash &&
    candidate.requestMaxOutputTokens === accepted.requestMaxOutputTokens &&
    candidate.mediaOccurrenceCount === accepted.mediaOccurrenceCount &&
    stableJsonStringify(candidate.promptSegments) ===
      stableJsonStringify(accepted.promptSegments)
  );
}

function cancelledToolCompletions(
  toolCalls: readonly ToolCall[],
  startIndex: number,
  activeCall?: ToolCall,
): SyntheticToolCompletionInput[] {
  const completions: SyntheticToolCompletionInput[] = [];
  for (let index = startIndex; index < toolCalls.length; index += 1) {
    const call = requireToolCall(toolCalls, index);
    completions.push({
      call,
      kind: "synthetic",
      reason: call === activeCall ? "cancelled_active" : "skipped_after_cancel",
    });
  }
  return completions;
}

function failedToolCompletions(
  toolCalls: readonly ToolCall[],
  startIndex: number,
  error: unknown,
): SyntheticToolCompletionInput[] {
  const completions: SyntheticToolCompletionInput[] = [];
  for (let index = startIndex; index < toolCalls.length; index += 1) {
    const call = requireToolCall(toolCalls, index);
    completions.push(
      index === startIndex
        ? {
            call,
            kind: "synthetic",
            reason: "failed_active",
            detail: normalizeSyntheticDetail(error),
          }
        : { call, kind: "synthetic", reason: "skipped_after_failure" },
    );
  }
  return completions;
}

function requireToolCall(toolCalls: readonly ToolCall[], index: number): ToolCall {
  const call = toolCalls[index];
  if (call === undefined) {
    throw new Error(`Missing tool call at index ${index}.`);
  }
  return call;
}

function requireCallInIteration(
  call: ToolCall,
  iteration: IterationIdentity,
  toolCallNumber: number,
): void {
  if (
    call.sessionId !== iteration.sessionId ||
    call.turnId !== iteration.turnId ||
    call.iterationId !== iteration.iterationId ||
    call.toolCallNumber !== toolCallNumber
  ) {
    throw new Error(
      `Tool call ${call.toolCallId} has invalid identity for iteration ${iteration.iterationId}.`,
    );
  }
}

function cancellation(
  signal: AbortSignal,
  iteration: IterationIdentity,
  phase: TurnCancellation["phase"],
  call?: ToolCall,
): TurnCancellation {
  return {
    source: turnCancellationSource(signal),
    phase,
    iterationId: iteration.iterationId,
    iterationNumber: iteration.iterationNumber,
    toolCallId: call?.toolCallId,
    toolName: call?.name,
  };
}

function cancelledResult(
  turnCancellation: TurnCancellation,
  lastIteration: IterationIdentity,
): RunAgentResult {
  return {
    status: "cancelled",
    cancellation: turnCancellation,
    lastIteration,
  };
}

function failedResult(
  error: unknown,
  lastIteration: IterationIdentity,
): Extract<RunAgentResult, { status: "failed" }> {
  return {
    status: "failed",
    error: errorMessage(error),
    lastIteration,
  };
}

function isReasoningOnlyProviderError(error: unknown): error is ProviderResponseError {
  return (
    error instanceof ProviderResponseError && error.code === "reasoning_only_assistant"
  );
}

function isTransientProviderError(error: unknown): error is ProviderResponseError {
  return (
    error instanceof ProviderResponseError &&
    (error.code === "provider_rate_limited" || error.code === "provider_unavailable")
  );
}

type ModelRequestRetryDecision =
  | {
      disposition: "scheduled";
      kind: "reasoning_only" | "transient";
      delayMs: number;
    }
  | { disposition: "exhausted"; kind: "reasoning_only" | "transient" }
  | { disposition: "not_retryable" };

function modelRequestRetryDecision(
  error: unknown,
  state: {
    reasoningOnlyRetries: number;
    transientRetries: number;
    transientRetryDelaysMs: readonly number[];
  },
): ModelRequestRetryDecision {
  if (isReasoningOnlyProviderError(error)) {
    return state.reasoningOnlyRetries < REASONING_ONLY_RETRY_LIMIT
      ? { disposition: "scheduled", kind: "reasoning_only", delayMs: 0 }
      : { disposition: "exhausted", kind: "reasoning_only" };
  }
  if (isTransientProviderError(error)) {
    const delayMs = state.transientRetryDelaysMs[state.transientRetries];
    return delayMs === undefined
      ? { disposition: "exhausted", kind: "transient" }
      : { disposition: "scheduled", kind: "transient", delayMs };
  }
  return { disposition: "not_retryable" };
}

async function waitForRetryDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0 || signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(cleanup, delayMs);
    signal.addEventListener("abort", cleanup, { once: true });
    function cleanup() {
      clearTimeout(timer);
      signal.removeEventListener("abort", cleanup);
      resolve();
    }
  });
}

function modelRequestFailureData(input: {
  error: unknown;
  request: PreparedModelRequest;
  attemptNumber: number;
  retryDisposition: "scheduled" | "not_retryable" | "exhausted";
  retryDelayMs?: number;
}) {
  const providerError =
    input.error instanceof ProviderResponseError ? input.error : undefined;
  return {
    attemptNumber: input.attemptNumber,
    maxAttempts: MODEL_REQUEST_MAX_ATTEMPTS,
    code: providerError?.code ?? ("provider_request_error" as const),
    retryDisposition: input.retryDisposition,
    ...(input.retryDelayMs === undefined ? {} : { retryDelayMs: input.retryDelayMs }),
    provider: input.request.provider,
    model: input.request.model,
    error: errorMessage(input.error),
    ...(providerError === undefined ? {} : { diagnostics: providerError.diagnostics }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
