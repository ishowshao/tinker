export type ToolCall = {
  id: string;
  name: string;
  args: unknown;
  rawArgs?: string;
  argsParseError?: string;
};

export type AgentMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content?: string | null;
      toolCalls?: ToolCall[];
    }
  | {
      role: "tool";
      toolCallId: string;
      name: string;
      content: string;
    };

export type RunAgentResult =
  | {
      ok: true;
      finalText: string;
      messages: AgentMessage[];
    }
  | {
      ok: false;
      error: string;
      messages: AgentMessage[];
    };
