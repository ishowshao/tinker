import type { ModelClient } from "../../model/model-client";
import type { ToolExecutionContext } from "../types";

export type Refiner = {
  refine(
    input: { url: string; prompt: string; content: string },
    context: ToolExecutionContext,
  ): Promise<string>;
};

const REFINE_SYSTEM_PROMPT = [
  "You extract information from web page content for a coding agent.",
  "Answer the prompt using only the provided page content.",
  "Be concise. Quote relevant code snippets, URLs, and facts verbatim when useful.",
  "If the content does not contain the requested information, say so explicitly.",
].join("\n");

const DEFAULT_MAX_CONTENT_CHARS = 50_000;

export function createModelRefiner(options: {
  createModelClient: () => ModelClient;
  maxContentChars?: number;
}): Refiner {
  const maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  let client: ModelClient | undefined;

  return {
    async refine(input, context) {
      client ??= options.createModelClient();

      const truncated = input.content.length > maxContentChars;
      const content = truncated
        ? input.content.slice(0, maxContentChars)
        : input.content;

      const output = await client.request(
        {
          messages: [
            { role: "system", content: REFINE_SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                `Web page: ${input.url}`,
                truncated
                  ? `Page content (markdown, truncated to ${maxContentChars} characters):`
                  : "Page content (markdown):",
                "",
                content,
                "",
                "---",
                "",
                `Prompt: ${input.prompt}`,
              ].join("\n"),
            },
          ],
          tools: [],
        },
        { signal: context.signal },
      );

      const message = output.message;
      if (
        message.role !== "assistant" ||
        typeof message.content !== "string" ||
        message.content.trim() === ""
      ) {
        throw new Error("Refine model returned no text content.");
      }

      return message.content;
    },
  };
}
