import { Box, Text, useApp } from "ink";
import { useEffect, useMemo, useState } from "react";
import type { RunAgentResult } from "../agent/types";
import type { TuiEventStream } from "../events/tui-event-stream";
import { applyAgentEvent, createInitialTuiState } from "./event-store";
import type { PromptHistory } from "./prompt-history";
import { Footer } from "./components/footer";
import { BackgroundTasks } from "./components/background-tasks";
import { Header } from "./components/header";
import { PromptInput } from "./components/prompt-input";
import { Timeline } from "./components/timeline";
import { findSlashCommand } from "./slash-commands";

export type AppProps = {
  modelName: string;
  workspaceRoot: string;
  runId: string;
  eventStream: TuiEventStream;
  run: (prompt: string) => Promise<RunAgentResult>;
  history?: PromptHistory;
  onQuit?: () => void;
};

export function App(props: AppProps) {
  const { exit } = useApp();
  const initialState = useMemo(
    () =>
      createInitialTuiState({
        runId: props.runId,
        modelName: props.modelName,
        workspaceRoot: props.workspaceRoot,
      }),
    [props.runId, props.modelName, props.workspaceRoot],
  );
  const [state, setState] = useState(initialState);
  const [isRunning, setIsRunning] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  useEffect(() => {
    return props.eventStream.subscribe((event) => {
      setState((current) => applyAgentEvent(current, event));
    });
  }, [props.eventStream]);

  const onSubmit = (prompt: string) => {
    const trimmed = prompt.trim();

    if (trimmed.startsWith("/")) {
      const command = findSlashCommand(trimmed);

      if (command === undefined) {
        setNotice(`Unknown command: ${trimmed}`);
        return;
      }

      setNotice(undefined);

      if (command.name === "quit") {
        props.onQuit?.();
        exit();
      }
      return;
    }

    if (trimmed === "" || isRunning) {
      return;
    }

    setNotice(undefined);
    setIsRunning(true);
    void props.history?.append(trimmed).catch(() => undefined);
    void props
      .run(trimmed)
      .catch(() => undefined)
      .finally(() => {
        setIsRunning(false);
      });
  };

  return (
    <Box flexDirection="column">
      <Header
        modelName={props.modelName}
        workspaceRoot={props.workspaceRoot}
        runId={props.runId}
      />
      <Box marginTop={1} flexDirection="column">
        <Timeline events={props.eventStream.events} items={state.timeline} />
      </Box>
      {state.backgroundTasks.length === 0 ? null : (
        <Box marginTop={1}>
          <BackgroundTasks tasks={state.backgroundTasks} />
        </Box>
      )}
      <Box marginTop={1}>
        <Footer status={state.status} />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <PromptInput
          isDisabled={isRunning}
          history={props.history}
          onSubmit={onSubmit}
          placeholder='Enter a coding request, or "/" for commands'
        />
        {notice === undefined ? null : <Text color="yellow">{notice}</Text>}
      </Box>
    </Box>
  );
}
