import { render } from "ink";
import { runAgent } from "../agent/loop";
import type { AgentMessage } from "../agent/types";
import { CompositeEventSink } from "../events/composite-event-sink";
import { JsonlEventLog } from "../events/jsonl-event-log";
import { ObservationTextLog } from "../events/observation-text-log";
import { TuiEventStream } from "../events/tui-event-stream";
import { ObservationBuilder } from "../observation/observation-builder";
import { createDefaultTooling } from "../tools/registry";
import { App } from "../tui/app";
import {
  createModelClientFromEnv,
  eventLogPath,
  observationLogPath,
  readRunnerConfig,
  SYSTEM_PROMPT,
} from "./config";

export async function runTui(): Promise<void> {
  const config = readRunnerConfig();
  const eventStream = new TuiEventStream();
  const tooling = createDefaultTooling({
    workspaceRoot: config.workspaceRoot,
    runId: config.runId,
  });
  let sessionMessages: AgentMessage[] | undefined;

  const run = async (userPrompt: string) => {
    const eventSink = new CompositeEventSink([
      new JsonlEventLog(eventLogPath(config.workspaceRoot, config.runId)),
      new ObservationTextLog(observationLogPath(config.workspaceRoot, config.runId)),
      eventStream,
    ]);

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
      const result = await runAgent({
        systemPrompt: SYSTEM_PROMPT(config.workspaceRoot),
        userPrompt,
        initialMessages: sessionMessages,
        maxSteps: config.maxSteps,
        model: createModelClientFromEnv(config.modelName),
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
      } else {
        await eventSink.append({
          type: "run.failed",
          error: result.error,
        });
      }

      sessionMessages = result.messages;
      return result;
    } catch (error) {
      await eventSink.append({
        type: "run.failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  let quitRequested = false;
  const onQuit = () => {
    quitRequested = true;
    instance.unmount();
    restoreStdin();
  };

  const instance = render(
    <App
      modelName={config.modelName}
      workspaceRoot={config.workspaceRoot}
      runId={config.runId}
      eventStream={eventStream}
      run={run}
      onQuit={onQuit}
    />,
  );

  await instance.waitUntilExit();
  restoreStdin();

  if (quitRequested) {
    process.exit(0);
  }
}

function restoreStdin(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }

  process.stdin.pause();
}
