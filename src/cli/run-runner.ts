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
import { runAgent } from "../agent/loop";
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
        options.eventLogPath ?? eventLogPath(config.workspaceRoot, config.runId),
      ),
    );
    sinks.push(
      new ObservationTextLog(observationLogPath(config.workspaceRoot, config.runId)),
    );
  }

  sinks.push(new StdoutEventPrinter(stdout, stderr));

  const eventSink = new CompositeEventSink(sinks);

  await eventSink.append({
    type: "run.started",
    runId: config.runId,
    createdAt: new Date().toISOString(),
    input: {
      userPrompt,
      workspaceRoot: config.workspaceRoot,
      model: config.modelName,
      maxSteps: config.maxSteps,
      includeReasoningContent: config.includeReasoningContent,
    },
  });

  let mcpManager: McpManager | undefined;
  let tooling: DefaultTooling | undefined;

  try {
    tooling = createDefaultTooling({
      workspaceRoot: config.workspaceRoot,
      runId: config.runId,
      eventSink,
      webFetchRefiner: createWebFetchRefinerFromEnv(config.modelName),
    });

    const mcpConfig = await loadMcpConfig(config.workspaceRoot);
    if (mcpConfig !== undefined) {
      mcpManager = await createMcpManager({ config: mcpConfig, eventSink });
      for (const executor of mcpManager.executors) {
        tooling.registry.register(executor);
      }
    }

    const result = await runAgent({
      systemPrompt: SYSTEM_PROMPT(config.workspaceRoot),
      userPrompt,
      maxSteps: config.maxSteps,
      model:
        options.modelClient ??
        createModelClientFromEnv(config.modelName, {
          includeReasoningContent: config.includeReasoningContent,
        }),
      tools: tooling.registry,
      toolRuntime: tooling.runtime,
      observationBuilder: new ObservationBuilder(),
      eventSink,
      signal: new AbortController().signal,
    });

    if (result.status === "completed") {
      await eventSink.append({
        type: "run.finished",
        finishedAt: new Date().toISOString(),
        result,
      });
      stdout.write(`\n${result.finalText}\n`);
      return 0;
    }

    if (result.status === "cancelled") {
      await eventSink.append({
        type: "run.cancelled",
        cancelledAt: new Date().toISOString(),
        cancellation: result.cancellation,
      });
      return 1;
    }

    await eventSink.append({
      type: "run.failed",
      error: result.error,
    });
    return 1;
  } catch (error) {
    await eventSink.append({
      type: "run.failed",
      error: error instanceof Error ? error.message : String(error),
    });
    return 1;
  } finally {
    try {
      await tooling?.dispose("oneshot_complete");
    } finally {
      await mcpManager?.dispose();
    }
  }
}
