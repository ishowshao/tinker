import { CompositeEventSink } from "../events/composite-event-sink";
import type { EventSink } from "../events/event-sink";
import { JsonlEventLog } from "../events/jsonl-event-log";
import { StdoutEventPrinter, type WritableLike } from "../events/stdout-event-printer";
import type { ModelClient } from "../model/model-client";
import { ObservationBuilder } from "../observation/observation-builder";
import { createDefaultTooling } from "../tools/registry";
import { runAgent } from "../agent/loop";
import {
  createModelClientFromEnv,
  eventLogPath,
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
    },
  });

  try {
    const tooling = createDefaultTooling({
      workspaceRoot: config.workspaceRoot,
    });
    const result = await runAgent({
      systemPrompt: SYSTEM_PROMPT(config.workspaceRoot),
      userPrompt,
      maxSteps: config.maxSteps,
      model: options.modelClient ?? createModelClientFromEnv(config.modelName),
      tools: tooling.registry,
      toolRuntime: tooling.runtime,
      observationBuilder: new ObservationBuilder(),
      eventSink,
    });

    if (result.ok) {
      await eventSink.append({
        type: "run.finished",
        result,
      });
      stdout.write(`\n${result.finalText}\n`);
      return 0;
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
  }
}
