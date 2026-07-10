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
      reasoningContent?: string | null;
      toolCalls?: ToolCall[];
    }
  | {
      role: "tool";
      toolCallId: string;
      name: string;
      content: string;
    };

export type TurnCancellation = {
  source: "user";
  phase: "model_request" | "tool_execution" | "agent_boundary";
  step: number;
  toolCallId?: string;
  toolName?: string;
};

export type RunAgentResult =
  | {
      status: "completed";
      finalText: string;
      messages: AgentMessage[];
    }
  | {
      status: "failed";
      error: string;
      messages: AgentMessage[];
    }
  | {
      status: "cancelled";
      cancellation: TurnCancellation;
      messages: AgentMessage[];
    };
