import type { AgentMessage } from "../agent/types";
import type { ToolDefinition } from "../tools/types";

export interface ModelClient {
  step(input: ModelStepInput, options: ModelStepOptions): Promise<ModelStepOutput>;
}

export type ModelStepOptions = {
  signal: AbortSignal;
};

export type ModelStepInput = {
  messages: AgentMessage[];
  tools: ToolDefinition[];
};

export type ModelStepOutput = {
  message: AgentMessage;
  finishReason?: string;
  usage?: unknown;
  rawResponse?: unknown;
};
