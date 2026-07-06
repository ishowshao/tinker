import { Box, Text, useApp } from "ink";
import { useEffect, useMemo, useState } from "react";
import type { RunAgentResult } from "../agent/types";
import type { TuiEventStream } from "../events/tui-event-stream";
import { applyAgentEvent, createInitialTuiState } from "./event-store";
import { Footer } from "./components/footer";
import { Header } from "./components/header";
import { PromptInput } from "./components/prompt-input";
import { Timeline } from "./components/timeline";

export type AppProps = {
  modelName: string;
  workspaceRoot: string;
  runId: string;
  eventStream: TuiEventStream;
  run: (prompt: string) => Promise<RunAgentResult>;
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
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    return props.eventStream.subscribe((event) => {
      setState((current) => applyAgentEvent(current, event));
    });
  }, [props.eventStream]);

  useEffect(() => {
    if (!submitted || (state.status !== "done" && state.status !== "failed")) {
      return;
    }

    const timeout = setTimeout(() => {
      exit();
    }, 200);

    return () => clearTimeout(timeout);
  }, [exit, state.status, submitted]);

  const onSubmit = (prompt: string) => {
    const trimmed = prompt.trim();
    if (trimmed === "" || state.status === "running") {
      return;
    }

    setSubmitted(true);
    void props.run(trimmed).catch(() => undefined);
  };

  return (
    <Box flexDirection="column">
      <Header
        modelName={props.modelName}
        workspaceRoot={props.workspaceRoot}
        runId={props.runId}
      />
      <Box marginTop={1}>
        <PromptInput
          isDisabled={submitted}
          onSubmit={onSubmit}
          placeholder="Enter a coding request"
        />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Timeline events={props.eventStream.events} items={state.timeline} />
      </Box>
      {state.finalText !== undefined && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Final</Text>
          <Text>{state.finalText}</Text>
        </Box>
      )}
      {state.error !== undefined && (
        <Box marginTop={1}>
          <Text color="red">{state.error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Footer status={state.status} />
      </Box>
    </Box>
  );
}
