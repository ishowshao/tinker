import type { AgentMessage, AssistantMessage, IterationIdentity } from "../agent/types";
import type { RuntimeSessionContext } from "../agent/runtime-session";
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
    runtimeSession: RuntimeSessionContext;
  };
};

export type ModelRequestInput = {
  messages: AgentMessage[];
  tools: ToolDefinition[];
};

export type ModelRequestOutput = {
  message: AssistantMessage;
  finishReason?: string;
  usage?: ModelUsage;
  rawResponse?: unknown;
};

export type ModelUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  source: "provider" | "estimated";
};
