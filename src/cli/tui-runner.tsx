import { render } from "ink";
import { runAgent } from "../agent/loop";
import { RuntimeSession } from "../agent/runtime-session";
import type { AgentMessage } from "../agent/types";
import { CompositeEventSink } from "../events/composite-event-sink";
import { JsonlEventLog } from "../events/jsonl-event-log";
import { ObservationTextLog } from "../events/observation-text-log";
import { TuiEventStream } from "../events/tui-event-stream";
import { loadMcpConfig } from "../mcp/mcp-config";
import { createMcpManager, type McpManager } from "../mcp/mcp-manager";
import { ObservationBuilder } from "../observation/observation-builder";
import { createDefaultTooling, type DefaultTooling } from "../tools/registry";
import { App } from "../tui/app";
import { readCurrentGitBranch } from "../tui/git-branch";
import { PromptHistory } from "../tui/prompt-history";
import {
  createModelClientFromEnv,
  createWebFetchRefinerFromEnv,
  eventLogPath,
  observationLogPath,
  promptHistoryPath,
  readRunnerConfig,
  SYSTEM_PROMPT,
} from "./config";

export async function runTui(): Promise<void> {
  const config = readRunnerConfig();
  const eventStream = new TuiEventStream();
  const runtimeSession = new RuntimeSession(
    new CompositeEventSink([
      new JsonlEventLog(eventLogPath(config.workspaceRoot, config.sessionId)),
      new ObservationTextLog(
        observationLogPath(config.workspaceRoot, config.sessionId),
      ),
      eventStream,
    ]),
    { sessionId: config.sessionId },
  );

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

  let tooling: DefaultTooling | undefined;
  let mcpManager: McpManager | undefined;
  let quitRequested = false;

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

    const promptHistory = await PromptHistory.load(
      promptHistoryPath(config.workspaceRoot),
    );
    let sessionMessages: AgentMessage[] | undefined;

    const run = async (userPrompt: string, signal: AbortSignal) => {
      const turn = runtimeSession.createTurn(userPrompt);
      await runtimeSession.append({
        type: "turn.started",
        ...turn,
        data: { userPrompt },
      });

      try {
        const result = await runAgent({
          systemPrompt: SYSTEM_PROMPT(config.workspaceRoot),
          userPrompt,
          initialMessages: sessionMessages,
          maxIterations: config.maxIterations,
          model: createModelClientFromEnv(config.modelName, {
            includeReasoningContent: config.includeReasoningContent,
          }),
          tools: tooling!.registry,
          toolRuntime: tooling!.runtime,
          observationBuilder: new ObservationBuilder(),
          runtimeSession,
          turn,
          signal,
        });

        if (result.status === "completed") {
          await runtimeSession.append({
            type: "turn.finished",
            ...turn,
            data: { result },
          });
        } else if (result.status === "cancelled") {
          await runtimeSession.append({
            type: "turn.cancelled",
            ...result.lastIteration,
            data: { cancellation: result.cancellation },
          });
        } else {
          await runtimeSession.append({
            type: "turn.failed",
            ...result.lastIteration,
            data: { error: result.error },
          });
        }

        sessionMessages = result.messages;
        return result;
      } catch (error) {
        await runtimeSession.append({
          type: "turn.failed",
          ...turn,
          data: { error: error instanceof Error ? error.message : String(error) },
        });
        throw error;
      }
    };

    const instance = render(
      <App
        modelName={config.modelName}
        workspaceRoot={config.workspaceRoot}
        sessionId={config.sessionId}
        eventStream={eventStream}
        run={run}
        readGitBranch={readCurrentGitBranch}
        history={promptHistory}
        onQuit={() => {
          quitRequested = true;
        }}
      />,
    );

    try {
      await instance.waitUntilExit();
    } finally {
      restoreStdin();
    }
  } finally {
    try {
      await tooling?.dispose("tui_exit");
    } finally {
      await mcpManager?.dispose();
      await runtimeSession.append({
        type: "session.finished",
        sessionId: runtimeSession.sessionId,
        data: { reason: "tui_exit" },
      });
    }
  }

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
