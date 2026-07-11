import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { TurnCancelledError } from "../agent/turn-cancellation";
import type { RunAgentResult } from "../agent/types";
import type { SessionId } from "../ids/runtime-id";
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
  sessionId: SessionId;
  eventStream: TuiEventStream;
  run: (prompt: string, signal: AbortSignal) => Promise<RunAgentResult>;
  readGitBranch?: (workspaceRoot: string) => Promise<string | undefined>;
  history?: PromptHistory;
  onQuit?: () => void;
};

export function App(props: AppProps) {
  const { exit } = useApp();
  const { readGitBranch, workspaceRoot } = props;
  const initialState = useMemo(
    () =>
      createInitialTuiState({
        sessionId: props.sessionId,
        modelName: props.modelName,
        workspaceRoot: props.workspaceRoot,
      }),
    [props.sessionId, props.modelName, props.workspaceRoot],
  );
  const [state, setState] = useState(initialState);
  const [isRunning, setIsRunning] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [gitBranch, setGitBranch] = useState<string | undefined>(undefined);
  const [gitBranchRefresh, setGitBranchRefresh] = useState(0);
  const gitBranchReadQueue = useRef<Promise<void>>(Promise.resolve());
  const activeController = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    return props.eventStream.subscribe((event) => {
      setState((current) => applyAgentEvent(current, event));
    });
  }, [props.eventStream]);

  useEffect(() => {
    if (readGitBranch === undefined) {
      return;
    }

    let isCurrent = true;
    const read = gitBranchReadQueue.current.then(() => readGitBranch(workspaceRoot));
    gitBranchReadQueue.current = read.then(
      (branch) => {
        if (isCurrent) {
          setGitBranch(branch);
        }
      },
      () => {
        if (isCurrent) {
          setGitBranch(undefined);
        }
      },
    );

    return () => {
      isCurrent = false;
    };
  }, [readGitBranch, workspaceRoot, gitBranchRefresh]);

  useInput(
    (_input, key) => {
      if (!key.escape) {
        return;
      }

      const controller = activeController.current;
      if (controller === undefined || controller.signal.aborted) {
        return;
      }

      controller.abort(new TurnCancelledError());
      setIsCancelling(true);
      setNotice("Cancelling current turn...");
    },
    { isActive: isRunning },
  );

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
    setIsCancelling(false);
    const controller = new AbortController();
    activeController.current = controller;
    void props.history?.append(trimmed).catch(() => undefined);
    void props
      .run(trimmed, controller.signal)
      .catch(() => undefined)
      .finally(() => {
        if (activeController.current === controller) {
          activeController.current = undefined;
          setIsRunning(false);
          setIsCancelling(false);
          setNotice(undefined);
          setGitBranchRefresh((current) => current + 1);
        }
      });
  };

  return (
    <Box flexDirection="column">
      <Header
        modelName={props.modelName}
        workspaceRoot={props.workspaceRoot}
        sessionId={props.sessionId}
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
        <Footer
          status={isCancelling ? "cancelling" : state.status}
          workedForMs={state.workedForMs}
        />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <PromptInput
          modelName={props.modelName}
          workspaceRoot={props.workspaceRoot}
          gitBranch={gitBranch}
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
