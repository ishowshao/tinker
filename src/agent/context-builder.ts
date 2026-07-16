import type { ToolDefinition } from "../tools/types";
import type {
  BuiltContextRequest,
  CompiledRevisionContext,
} from "../context/context-revision";
import type { ProtocolContextView } from "../context/protocol-frame";

export class ContextBuilder {
  build(input: {
    canonical: ProtocolContextView;
    compiled: CompiledRevisionContext;
    tools: readonly ToolDefinition[];
    candidateUserPrompt?: string;
  }): BuiltContextRequest {
    if (input.canonical.sessionId !== input.compiled.sessionId) {
      throw new Error(
        "Compiled context and canonical history belong to different sessions.",
      );
    }
    const messages = input.compiled.entries.map((entry) => entry.message);
    if (input.candidateUserPrompt !== undefined) {
      if (input.candidateUserPrompt.trim() === "") {
        throw new Error("Cannot build a candidate context with an empty prompt.");
      }
      messages.push({ role: "user", content: input.candidateUserPrompt });
    }
    return Object.freeze({
      canonical: input.canonical,
      compiled: input.compiled,
      request: {
        messages,
        tools: [...input.tools],
      },
      candidateUserPromptIncluded: input.candidateUserPrompt !== undefined,
    });
  }
}
