import type { ToolDefinition } from "../tools/types";
import type {
  BuiltContextRequest,
  CompiledRevisionContext,
  StoredContextRevisionV8,
  SwapOverride,
} from "../context/context-revision";
import type { ProtocolContextView } from "../context/protocol-frame";
import type { StoredContextSurfaceV8 } from "../context/context-surface";
import { stableJsonStringify } from "../model/model-request-preflight";

export class ContextBuilder {
  build(input: {
    canonical: ProtocolContextView;
    revision: StoredContextRevisionV8;
    activeOverrides: readonly SwapOverride[];
    compiled: CompiledRevisionContext;
    surface: StoredContextSurfaceV8;
    tools: readonly ToolDefinition[];
    candidateUserPrompt?: string;
  }): BuiltContextRequest {
    if (input.canonical.sessionId !== input.compiled.sessionId) {
      throw new Error(
        "Compiled context and canonical history belong to different sessions.",
      );
    }
    if (
      input.surface.sessionId !== input.canonical.sessionId ||
      input.surface.surfaceId !== input.revision.surfaceId ||
      input.surface.surfaceSha256 !== input.revision.surfaceSha256 ||
      stableJsonStringify(input.tools) !==
        stableJsonStringify(input.surface.toolDefinitions)
    ) {
      throw new Error(
        "Executable tool definitions do not match the active context surface.",
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
      revision: input.revision,
      surface: input.surface,
      activeOverrides: input.activeOverrides,
      compiled: input.compiled,
      request: {
        messages,
        tools: [...input.surface.toolDefinitions],
      },
      candidateUserPromptIncluded: input.candidateUserPrompt !== undefined,
    });
  }
}
