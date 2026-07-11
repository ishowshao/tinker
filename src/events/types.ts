import type {
  IterationIdentity,
  RunAgentResult,
  ToolCall,
  ToolCallIdentity,
  TurnCancellation,
  TurnIdentity,
} from "../agent/types";
import type { IterationId, SessionId, ToolCallId, TurnId } from "../ids/runtime-id";
import type { ModelRequestOutput } from "../model/model-client";
import type { ShellTaskSnapshot } from "../tools/bash-task";
import type { ToolObservation } from "../observation/observation-builder";
import type { ToolRawResult } from "../tools/types";

export type SessionStartedData = {
  workspaceRoot: string;
  model: string;
  maxIterations: number;
  includeReasoningContent: boolean;
};

export type AgentEventDataMap = {
  "session.started": SessionStartedData;
  "session.finished": { reason: "tui_exit" | "oneshot_complete" };
  "turn.started": { userPrompt: string };
  "turn.finished": { result: RunAgentResult };
  "turn.failed": { error: string };
  "turn.cancelled": { cancellation: TurnCancellation };
  "agent.iteration.started": { iterationNumber: number };
  "model.request.started": Record<string, never>;
  "model.request.finished": { output: ModelRequestOutput };
  "assistant.progress": { content: string };
  "tool.started": { call: ToolCall };
  "tool.raw_result": { call: ToolCall; raw: ToolRawResult };
  "tool.finished": { call: ToolCall; ok: boolean };
  "tool.observation": { call: ToolCall; observation: ToolObservation };
  "agent.iteration.finished": {
    outcome: "continue" | "completed";
    toolCallCount: number;
  };
  "bash.task.backgrounded": { task: ShellTaskSnapshot };
  "bash.task.stopping": { task: ShellTaskSnapshot };
  "bash.task.finished": { task: ShellTaskSnapshot };
  "mcp.server.connected": { serverName: string; toolCount: number };
  "mcp.server.failed": { serverName: string; error: string };
};

export type AgentEventType = keyof AgentEventDataMap;

type AgentEventEnvelope<TType extends AgentEventType> = {
  type: TType;
  sessionId: SessionId;
  turnId?: TurnId;
  iterationId?: IterationId;
  toolCallId?: ToolCallId;
  turnNumber?: number;
  iterationNumber?: number;
  toolCallNumber?: number;
  eventSequence: number;
  timestamp: string;
  data: AgentEventDataMap[TType];
};

export type AgentEvent = {
  [TType in AgentEventType]: AgentEventEnvelope<TType>;
}[AgentEventType];

type SessionEventInput<TType extends AgentEventType> = {
  type: TType;
  sessionId: SessionId;
  data: AgentEventDataMap[TType];
};

type TurnEventInput<TType extends AgentEventType> = TurnIdentity & {
  type: TType;
  data: AgentEventDataMap[TType];
};

type IterationEventInput<TType extends AgentEventType> = IterationIdentity & {
  type: TType;
  data: AgentEventDataMap[TType];
};

type ToolEventInput<TType extends AgentEventType> = ToolCallIdentity & {
  type: TType;
  data: AgentEventDataMap[TType];
};

export type AgentEventInput =
  | SessionEventInput<"session.started" | "session.finished">
  | SessionEventInput<"mcp.server.connected" | "mcp.server.failed">
  | TurnEventInput<"turn.started" | "turn.finished">
  | (
      | TurnEventInput<"turn.failed" | "turn.cancelled">
      | IterationEventInput<"turn.failed" | "turn.cancelled">
    )
  | IterationEventInput<
      | "agent.iteration.started"
      | "model.request.started"
      | "model.request.finished"
      | "assistant.progress"
      | "agent.iteration.finished"
    >
  | ToolEventInput<
      "tool.started" | "tool.raw_result" | "tool.finished" | "tool.observation"
    >
  | ToolEventInput<
      "bash.task.backgrounded" | "bash.task.stopping" | "bash.task.finished"
    >;
