import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { TurnCancelledError } from "../agent/turn-cancellation";
import { ContextBudgetExceededError } from "../model/model-request-preflight";
import { visibleTimelineItems } from "./event-store";
import type { PromptHistory } from "./prompt-history";
import { Footer } from "./components/footer";
import { ContextStatus } from "./components/context-status";
import { BackgroundTasks } from "./components/background-tasks";
import { Header } from "./components/header";
import { PromptInput } from "./components/prompt-input";
import {
  ResumeSessionPicker,
  ResumeSessionPickerLoading,
} from "./components/resume-session-picker";
import { Timeline } from "./components/timeline";
import { parseSlashCommand } from "./slash-commands";
import type { TuiSessionController } from "./tui-session-controller";
import type { SessionSummary } from "../session/session-catalog";

export type AppProps = {
  sessionController: TuiSessionController;
  readGitBranch?: (workspaceRoot: string) => Promise<string | undefined>;
  history?: PromptHistory;
  onQuit?: () => void;
};

type ResumePickerState =
  | { status: "loading" }
  | {
      status: "ready";
      sessions: readonly SessionSummary[];
      isResuming: boolean;
      error?: string;
    };

export function App(props: AppProps) {
  const { exit } = useApp();
  const binding = useSyncExternalStore(
    props.sessionController.subscribe,
    props.sessionController.getBinding,
    props.sessionController.getBinding,
  );
  const { readGitBranch, workspaceRoot } = {
    readGitBranch: props.readGitBranch,
    workspaceRoot: binding.workspaceRoot,
  };
  const state = useSyncExternalStore(
    binding.projectionStore.subscribe,
    binding.projectionStore.getSnapshot,
    binding.projectionStore.getSnapshot,
  );
  const [isRunning, setIsRunning] = useState(false);
  const [isSessionOperation, setIsSessionOperation] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [showStatus, setShowStatus] = useState(false);
  const [resumePicker, setResumePicker] = useState<ResumePickerState | undefined>(
    undefined,
  );
  const [gitBranch, setGitBranch] = useState<string | undefined>(undefined);
  const [gitBranchRefresh, setGitBranchRefresh] = useState(0);
  const gitBranchReadQueue = useRef<Promise<void>>(Promise.resolve());
  const activeController = useRef<AbortController | undefined>(undefined);
  const resumePickerRequest = useRef(0);

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

      controller.abort(new TurnCancelledError("user"));
      setIsCancelling(true);
      setNotice("Cancelling current turn...");
    },
    { isActive: isRunning },
  );

  const closeResumePicker = () => {
    resumePickerRequest.current += 1;
    setResumePicker(undefined);
    setIsSessionOperation(false);
    setNotice(undefined);
  };

  const openResumePicker = () => {
    const requestId = resumePickerRequest.current + 1;
    resumePickerRequest.current = requestId;
    setNotice(undefined);
    setResumePicker({ status: "loading" });
    setIsSessionOperation(true);
    void props.sessionController
      .listSessions()
      .then((sessions) => {
        if (resumePickerRequest.current !== requestId) {
          return;
        }
        if (sessions.length === 0) {
          setResumePicker(undefined);
          setNotice("No stored sessions found for this workspace.");
          return;
        }
        setResumePicker({ status: "ready", sessions, isResuming: false });
      })
      .catch((error: unknown) => {
        if (resumePickerRequest.current === requestId) {
          setResumePicker(undefined);
          setNotice(`Session operation failed: ${errorMessage(error)}`);
        }
      })
      .finally(() => {
        if (resumePickerRequest.current === requestId) {
          setIsSessionOperation(false);
        }
      });
  };

  const resumeSelectedSession = (session: SessionSummary) => {
    setResumePicker((current) =>
      current?.status === "ready"
        ? { ...current, isResuming: true, error: undefined }
        : current,
    );
    setIsSessionOperation(true);
    void props.sessionController
      .resume(session.sessionId)
      .then(() => {
        setResumePicker(undefined);
        setNotice(`Resumed session ${session.sessionId}.`);
      })
      .catch((error: unknown) => {
        setResumePicker((current) =>
          current?.status === "ready"
            ? {
                ...current,
                isResuming: false,
                error: errorMessage(error),
              }
            : current,
        );
      })
      .finally(() => setIsSessionOperation(false));
  };

  const onSubmit = (prompt: string) => {
    const trimmed = prompt.trim();
    setShowStatus(false);

    if (trimmed.startsWith("/")) {
      let command;
      try {
        command = parseSlashCommand(trimmed);
      } catch (error) {
        setNotice(errorMessage(error));
        return;
      }

      setNotice(undefined);

      if (command.type === "status") {
        setShowStatus(true);
        return;
      }
      if (command.type === "quit") {
        props.onQuit?.();
        exit();
        return;
      }
      if (command.type === "resume_list") {
        openResumePicker();
        return;
      }
      setIsSessionOperation(true);
      const operation =
        command.type === "resume"
          ? props.sessionController
              .resume(command.sessionId)
              .then(() => setNotice(`Resumed session ${command.sessionId}.`))
          : props.sessionController
              .delete(command.sessionId)
              .then(() => setNotice(`Deleted session ${command.sessionId}.`));
      void operation
        .catch((error: unknown) => {
          setNotice(`Session operation failed: ${errorMessage(error)}`);
        })
        .finally(() => setIsSessionOperation(false));
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
    let retainNotice = false;
    void Promise.resolve()
      .then(() => binding.executeTurn(trimmed, controller.signal))
      .catch((error: unknown) => {
        retainNotice = true;
        setNotice(
          error instanceof ContextBudgetExceededError
            ? error.message
            : `Runtime failed: ${errorMessage(error)}`,
        );
      })
      .finally(() => {
        if (activeController.current === controller) {
          activeController.current = undefined;
          setIsRunning(false);
          setIsCancelling(false);
          if (!retainNotice) {
            setNotice(undefined);
          }
          setGitBranchRefresh((current) => current + 1);
        }
      });
  };

  return (
    <Box flexDirection="column">
      {resumePicker?.status === "loading" ? (
        <ResumeSessionPickerLoading onCancel={closeResumePicker} />
      ) : resumePicker?.status === "ready" ? (
        <ResumeSessionPicker
          sessions={resumePicker.sessions}
          isResuming={resumePicker.isResuming}
          error={resumePicker.error}
          onCancel={closeResumePicker}
          onSelect={resumeSelectedSession}
        />
      ) : (
        <>
          <Header
            key={binding.sessionId}
            modelName={binding.modelName}
            workspaceRoot={binding.workspaceRoot}
            sessionId={binding.sessionId}
          />
          <Box marginTop={1} flexDirection="column">
            <Timeline items={visibleTimelineItems(state)} />
          </Box>
          {state.backgroundTasks.length === 0 ? null : (
            <Box marginTop={1}>
              <BackgroundTasks tasks={state.backgroundTasks} />
            </Box>
          )}
          {showStatus ? (
            <Box marginTop={1}>
              <ContextStatus state={state} />
            </Box>
          ) : null}
          <Box marginTop={1}>
            <Footer
              status={isCancelling ? "cancelling" : state.status}
              workedForMs={state.workedForMs}
            />
          </Box>
          <Box marginTop={1} flexDirection="column">
            <PromptInput
              modelName={binding.modelName}
              workspaceRoot={binding.workspaceRoot}
              gitBranch={gitBranch}
              contextUsage={state.contextUsage}
              isDisabled={isRunning || isSessionOperation}
              history={props.history}
              onSubmit={onSubmit}
              placeholder='Enter a coding request, or "/" for commands'
            />
            {notice === undefined ? null : <Text color="yellow">{notice}</Text>}
          </Box>
        </>
      )}
    </Box>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
