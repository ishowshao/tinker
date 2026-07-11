import type { AgentMessage } from "./types";
import type { ToolDefinition } from "../tools/types";
import type { ModelRequestInput } from "../model/model-client";

export class ContextBuilder {
  build(input: {
    messages: AgentMessage[];
    tools: ToolDefinition[];
  }): ModelRequestInput {
    return {
      messages: input.messages,
      tools: input.tools,
    };
  }
}
