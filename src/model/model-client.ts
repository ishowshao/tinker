import type { AgentMessage, AssistantMessage, IterationIdentity } from "../agent/types";
import type { RuntimeSession } from "../agent/runtime-session";
import type { ToolDefinition } from "../tools/types";

export interface ModelClient {
  request(
    input: ModelRequestInput,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput>;
}

export type ModelRequestOptions = {
  signal: AbortSignal;
  identity?: {
    iteration: IterationIdentity;
    runtimeSession: RuntimeSession;
  };
};

export type ModelRequestInput = {
  messages: AgentMessage[];
  tools: ToolDefinition[];
};

export type ModelRequestOutput = {
  message: AssistantMessage;
  finishReason?: string;
  usage?: unknown;
  rawResponse?: unknown;
};
