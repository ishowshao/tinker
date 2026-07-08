import type { ToolCall } from "../agent/types";

export type AgentEvent =
  | { type: "run.started"; runId: string; createdAt: string; input: unknown }
  | { type: "model.step.started"; step: number }
  | { type: "model.step.finished"; step: number; output: unknown }
  | { type: "assistant.progress"; step: number; content: string }
  | { type: "tool.started"; step: number; call: ToolCall }
  | { type: "tool.raw_result"; step: number; call: ToolCall; raw: unknown }
  | { type: "tool.finished"; step: number; call: ToolCall; ok: boolean }
  | { type: "tool.observation"; step: number; call: ToolCall; observation: unknown }
  | { type: "mcp.server.connected"; serverName: string; toolCount: number }
  | { type: "mcp.server.failed"; serverName: string; error: string }
  | { type: "run.finished"; result: unknown }
  | { type: "run.failed"; error: string };
