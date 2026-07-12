import type { ToolDefinition } from "../tools/types";
import type { ModelRequestInput } from "../model/model-client";
import {
  ContextProtocolValidator,
  type ContextProtocolValidationOptions,
} from "../context/context-protocol-validator";
import {
  materializeAgentMessages,
  type ProtocolContextView,
} from "../context/protocol-frame";

export class ContextBuilder {
  constructor(private readonly validator = new ContextProtocolValidator()) {}

  build(input: {
    view: ProtocolContextView;
    tools: readonly ToolDefinition[];
    validation?: ContextProtocolValidationOptions;
    candidateUserPrompt?: string;
  }): ModelRequestInput {
    this.validator.validate(input.view, input.validation);
    const messages = materializeAgentMessages(input.view.messages);
    if (input.candidateUserPrompt !== undefined) {
      if (input.candidateUserPrompt.trim() === "") {
        throw new Error("Cannot build a candidate context with an empty prompt.");
      }
      messages.push({ role: "user", content: input.candidateUserPrompt });
    }
    return {
      messages,
      tools: [...input.tools],
    };
  }
}
