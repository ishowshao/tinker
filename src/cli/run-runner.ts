import { runAgent } from "../agent/loop";
import { RuntimeSession } from "../agent/runtime-session";
import { CompositeEventSink } from "../events/composite-event-sink";
import type { EventSink } from "../events/event-sink";
import { JsonlEventLog } from "../events/jsonl-event-log";
import { ObservationTextLog } from "../events/observation-text-log";
import { StdoutEventPrinter, type WritableLike } from "../events/stdout-event-printer";
import { loadMcpConfig } from "../mcp/mcp-config";
import { createMcpManager, type McpManager } from "../mcp/mcp-manager";
import type { ModelClient } from "../model/model-client";
import { ObservationBuilder } from "../observation/observation-builder";
import { createDefaultTooling, type DefaultTooling } from "../tools/registry";
import {
  createModelClientFromEnv,
  createWebFetchRefinerFromEnv,
  eventLogPath,
  observationLogPath,
  readRunnerConfig,
  SYSTEM_PROMPT,
  type RunnerConfig,
} from "./config";

export type RunOneShotOptions = Partial<RunnerConfig> & {
  modelClient?: ModelClient;
  stdout?: WritableLike;
  stderr?: WritableLike;
  eventLogPath?: string | false;
};

export async function runOneShot(
  userPrompt: string,
  options: RunOneShotOptions = {},
): Promise<number> {
  const config = readRunnerConfig(options);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const sinks: EventSink[] = [];

  if (options.eventLogPath !== false) {
    sinks.push(
      new JsonlEventLog(
        options.eventLogPath ?? eventLogPath(config.workspaceRoot, config.sessionId),
      ),
      new ObservationTextLog(
        observationLogPath(config.workspaceRoot, config.sessionId),
      ),
    );
  }
  sinks.push(new StdoutEventPrinter(stdout, stderr));

  const runtimeSession = new RuntimeSession(new CompositeEventSink(sinks), {
    sessionId: config.sessionId,
  });
  await runtimeSession.append({
    type: "session.started",
    sessionId: runtimeSession.sessionId,
    data: {
      workspaceRoot: config.workspaceRoot,
      model: config.modelName,
      maxIterations: config.maxIterations,
      includeReasoningContent: config.includeReasoningContent,
    },
  });

  const turn = runtimeSession.createTurn(userPrompt);
  await runtimeSession.append({
    type: "turn.started",
    ...turn,
    data: { userPrompt },
  });

  let mcpManager: McpManager | undefined;
  let tooling: DefaultTooling | undefined;

  try {
    tooling = createDefaultTooling({
      workspaceRoot: config.workspaceRoot,
      runtimeSession,
      webFetchRefiner: createWebFetchRefinerFromEnv(config.modelName),
    });

    const mcpConfig = await loadMcpConfig(config.workspaceRoot);
    if (mcpConfig !== undefined) {
      mcpManager = await createMcpManager({ config: mcpConfig, runtimeSession });
      for (const executor of mcpManager.executors) {
        tooling.registry.register(executor);
      }
    }

    const result = await runAgent({
      systemPrompt: SYSTEM_PROMPT(config.workspaceRoot),
      userPrompt,
      maxIterations: config.maxIterations,
      model:
        options.modelClient ??
        createModelClientFromEnv(config.modelName, {
          includeReasoningContent: config.includeReasoningContent,
        }),
      tools: tooling.registry,
      toolRuntime: tooling.runtime,
      observationBuilder: new ObservationBuilder(),
      runtimeSession,
      turn,
      signal: new AbortController().signal,
    });

    if (result.status === "completed") {
      await runtimeSession.append({
        type: "turn.finished",
        ...turn,
        data: { result },
      });
      stdout.write(`\n${result.finalText}\n`);
      return 0;
    }

    if (result.status === "cancelled") {
      await runtimeSession.append({
        type: "turn.cancelled",
        ...result.lastIteration,
        data: { cancellation: result.cancellation },
      });
      return 1;
    }

    await runtimeSession.append({
      type: "turn.failed",
      ...result.lastIteration,
      data: { error: result.error },
    });
    return 1;
  } catch (error) {
    await runtimeSession.append({
      type: "turn.failed",
      ...turn,
      data: { error: error instanceof Error ? error.message : String(error) },
    });
    return 1;
  } finally {
    try {
      await tooling?.dispose("oneshot_complete");
    } finally {
      await mcpManager?.dispose();
      await runtimeSession.append({
        type: "session.finished",
        sessionId: runtimeSession.sessionId,
        data: { reason: "oneshot_complete" },
      });
    }
  }
}
