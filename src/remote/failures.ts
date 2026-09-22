import { ContextManagerError } from "../context/context-manager";
import { ContextBudgetExceededError } from "../model/model-request-preflight";
import { ModelRequestMediaAggregateError } from "../model/model-client";
import { ImageNotRecognizedError } from "../image/image-probe";

export type RemoteFailure = {
  name: string;
  message: string;
  maintenance?: Pick<ContextManagerError, "stage" | "code" | "fatal" | "committed">;
  context?: Pick<
    ContextBudgetExceededError,
    "projectedInputTokens" | "inputBudgetTokens" | "triggerTokens" | "source"
  >;
};
export function encodeFailure(error: unknown): RemoteFailure {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof ContextManagerError
      ? {
          maintenance: {
            stage: error.stage,
            code: error.code,
            fatal: error.fatal,
            committed: error.committed,
          },
        }
      : {}),
    ...(error instanceof ContextBudgetExceededError
      ? {
          context: {
            projectedInputTokens: error.projectedInputTokens,
            inputBudgetTokens: error.inputBudgetTokens,
            triggerTokens: error.triggerTokens,
            source: error.source,
          },
        }
      : {}),
    ...(error instanceof ModelRequestMediaAggregateError
      ? { name: "ModelRequestMediaAggregateError" }
      : {}),
    ...(error instanceof ImageNotRecognizedError
      ? { name: "ImageNotRecognizedError" }
      : {}),
  };
}
export function decodeFailure(failure: RemoteFailure): Error {
  if (failure.name === "ContextManagerError" && failure.maintenance) {
    const m = failure.maintenance;
    return new ContextManagerError(
      m.stage,
      m.code,
      m.fatal,
      m.committed,
      failure.message,
    );
  }
  if (failure.name === "ContextBudgetExceededError" && failure.context) {
    const error = new Error(failure.message);
    Object.setPrototypeOf(error, ContextBudgetExceededError.prototype);
    return Object.assign(error, { name: failure.name }, failure.context);
  }
  if (failure.name === "ModelRequestMediaAggregateError")
    return new ModelRequestMediaAggregateError(failure.message);
  if (failure.name === "ImageNotRecognizedError")
    return new ImageNotRecognizedError(failure.message);
  return new Error(failure.message);
}
