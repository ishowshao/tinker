import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { TurnCancelledError } from "../agent/turn-cancellation";
import {
  ContextManagerError,
  type ContextCompactionResult,
  type ContextRetirementResult,
} from "../context/context-manager";
import { ContextBudgetExceededError } from "../model/model-request-preflight";
import { ModelRequestMediaAggregateError } from "../model/model-client";
import type { SessionId } from "../ids/runtime-id";
import { readLastAssistantResponse } from "../session/session-last-response-reader";
import { visibleTimelineItems } from "./event-store";
import type { PromptHistory } from "./prompt-history";
import { Footer } from "./components/footer";
import { ContextStatus } from "./components/context-status";
import { BackgroundTasks } from "./components/background-tasks";
import { Header } from "./components/header";
import { ModelPicker } from "./components/model-picker";
import { FileViewer, FileViewerLoading } from "./components/file-viewer";
import {
  PromptInput,
  type PromptMaintenanceAction,
  type PromptSubmission,
  type PromptSubmissionOutcome,
} from "./components/prompt-input";
import { createPromptDraft } from "./prompt-draft";
import { SkillsPanel } from "./components/skills-panel";
import { McpPanel } from "./components/mcp-panel";
import {
  ResumeSessionPicker,
  ResumeSessionPickerLoading,
} from "./components/resume-session-picker";
import { Timeline } from "./components/timeline";
import { parseSlashCommand, SLASH_COMMANDS } from "./slash-commands";
import {
  resolveProjectSlashCommand,
  type ProjectSlashCommand,
} from "./project-slash-commands";
import type { TuiSessionController } from "./tui-session-controller";
import type { SessionSummary } from "../session/session-catalog";
import type { ModelProfile, ModelProfiles } from "../cli/model-profiles";
import { loadViewFile, type ViewFile } from "./view-file";
import { writeClipboardText } from "./clipboard";

export type AppProps = {
  sessionController: TuiSessionController;
  readGitBranch?: (workspaceRoot: string) => Promise<string | undefined>;
  history?: PromptHistory;
  projectSlashCommands?: readonly ProjectSlashCommand[];
  profiles?: ModelProfiles;
  persistDefaultProfile?: (profileName: string) => Promise<void>;
  readViewFile?: (workspaceRoot: string, filePath: string) => Promise<ViewFile>;
  readLastResponse?: (
    workspaceRoot: string,
    sessionId: SessionId,
  ) => Promise<string | undefined>;
  writeClipboard?: (markdown: string) => Promise<void>;
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

type ModelPickerState = {
  isSwitching: boolean;
  error?: string;
};

type FileViewState =
  | { status: "loading"; filePath: string }
  | { status: "ready"; file: ViewFile };

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
  const [isCopying, setIsCopying] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [showStatus, setShowStatus] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [resumePicker, setResumePicker] = useState<ResumePickerState | undefined>(
    undefined,
  );
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [modelPickerState, setModelPickerState] = useState<
    ModelPickerState | undefined
  >(undefined);
  const [fileView, setFileView] = useState<FileViewState | undefined>(undefined);
  const [viewError, setViewError] = useState<string | undefined>(undefined);
  const [gitBranch, setGitBranch] = useState<string | undefined>(undefined);
  const [gitBranchRefresh, setGitBranchRefresh] = useState(0);
  const gitBranchReadQueue = useRef<Promise<void>>(Promise.resolve());
  const activeController = useRef<AbortController | undefined>(undefined);
  const resumePickerRequest = useRef(0);
  const fileViewRequest = useRef(0);

  const canSwitchModel =
    state.recentTurns.length === 0 &&
    state.activeTurn === undefined &&
    props.profiles !== undefined &&
    props.profiles.profiles.size > 1;

  const builtInCommands = canSwitchModel
    ? SLASH_COMMANDS
    : SLASH_COMMANDS.filter((command) => command.name !== "model");
  const availableCommands = [...builtInCommands, ...(props.projectSlashCommands ?? [])];

  const profileList = props.profiles ? [...props.profiles.profiles.values()] : [];

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

  const closeModelPicker = () => {
    setShowModelPicker(false);
    setModelPickerState(undefined);
    setNotice(undefined);
  };

  const doSwitchModel = (profile: ModelProfile) => {
    setShowModelPicker(false);
    setModelPickerState(undefined);
    setNotice(undefined);
    setIsSessionOperation(true);
    void props.sessionController
      .switchModel(profile)
      .then(async () => {
        setGitBranchRefresh((current) => current + 1);
        try {
          await props.persistDefaultProfile?.(profile.name);
          setNotice(`Switched to model profile "${profile.name}" (${profile.model}).`);
        } catch (error) {
          setNotice(
            `Switched to model profile "${profile.name}" (${profile.model}), but failed to save it as the default: ${errorMessage(error)}`,
          );
        }
      })
      .catch((error: unknown) => {
        setNotice(`Model switch failed: ${errorMessage(error)}`);
      })
      .finally(() => setIsSessionOperation(false));
  };

  const closeFileView = () => {
    fileViewRequest.current += 1;
    setFileView(undefined);
  };

  const openFileView = (filePath: string) => {
    const requestId = fileViewRequest.current + 1;
    fileViewRequest.current = requestId;
    setNotice(undefined);
    setViewError(undefined);
    setFileView({ status: "loading", filePath });

    void Promise.resolve()
      .then(() => (props.readViewFile ?? loadViewFile)(workspaceRoot, filePath))
      .then((file) => {
        if (fileViewRequest.current === requestId) {
          setFileView({ status: "ready", file });
        }
      })
      .catch((error: unknown) => {
        if (fileViewRequest.current === requestId) {
          setFileView(undefined);
          setViewError(`View failed: ${errorMessage(error)}`);
        }
      });
  };

  const copyLastResponse = () => {
    setIsCopying(true);
    void Promise.resolve()
      .then(() =>
        props.readLastResponse === undefined
          ? readLastAssistantResponse({
              workspaceRoot,
              sessionId: binding.sessionId,
            })
          : props.readLastResponse(workspaceRoot, binding.sessionId),
      )
      .then(async (markdown) => {
        if (markdown === undefined) {
          setNotice("No assistant response is available to copy.");
          return;
        }
        await (props.writeClipboard ?? writeClipboardText)(markdown);
        setNotice("Copied last response as Markdown.");
      })
      .catch((error: unknown) => {
        setNotice(`Copy failed: ${errorMessage(error)}`);
      })
      .finally(() => setIsCopying(false));
  };

  const submitAgentPrompt = async (
    submission: PromptSubmission,
    admissionSignal: AbortSignal,
  ): Promise<PromptSubmissionOutcome> => {
    if (isRunning) return false;
    setNotice(undefined);
    setIsCancelling(false);
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(admissionSignal.reason);
    if (admissionSignal.aborted) {
      forwardAbort();
    } else {
      admissionSignal.addEventListener("abort", forwardAbort, { once: true });
    }

    let accepted;
    try {
      if (binding.admitTurn === undefined) {
        throw new Error("TUI session binding does not implement turn admission.");
      }
      accepted = await binding.admitTurn(submission.userMessage, controller.signal);
    } catch (error) {
      admissionSignal.removeEventListener("abort", forwardAbort);
      if (
        error instanceof ContextBudgetExceededError ||
        error instanceof ModelRequestMediaAggregateError
      ) {
        return {
          kind: "maintenance_offer",
          reason:
            error instanceof ContextBudgetExceededError ? "budget" : "media_aggregate",
          message: error.message,
        };
      }
      setNotice(`Turn was not accepted: ${errorMessage(error)}`);
      return false;
    }

    activeController.current = controller;
    setIsRunning(true);
    void props.history?.append(submission.draft).catch((error: unknown) => {
      setNotice(`Prompt history write failed: ${errorMessage(error)}`);
    });
    void accepted.completion
      .catch((error: unknown) => {
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
          setNotice((current) =>
            current === "Cancelling current turn..." ? undefined : current,
          );
          setGitBranchRefresh((current) => current + 1);
        }
        admissionSignal.removeEventListener("abort", forwardAbort);
      });
    return true;
  };

  const onMaintenance = async (
    action: PromptMaintenanceAction,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    setIsSessionOperation(true);
    try {
      if (action === "compact") {
        const result = await props.sessionController.compact();
        signal.throwIfAborted();
        setNotice(formatContextCompactionNotice(result));
        return;
      }
      if (action === "retire") {
        const result = await props.sessionController.retire();
        signal.throwIfAborted();
        setNotice(formatContextRetirementNotice(result));
        return;
      }
      await props.sessionController.clear();
      signal.throwIfAborted();
      const sessionId = props.sessionController.getBinding().sessionId;
      setGitBranchRefresh((current) => current + 1);
      setNotice(
        `Started new session ${sessionId}. The image Prompt was preserved and was not submitted.`,
      );
    } finally {
      setIsSessionOperation(false);
    }
  };

  const onSubmit = (
    submission: PromptSubmission,
    signal: AbortSignal,
  ): PromptSubmissionOutcome | Promise<PromptSubmissionOutcome> => {
    const { userMessage } = submission;
    const trimmed = userMessage.content.trim();
    setShowStatus(false);
    setShowSkills(false);
    setShowMcp(false);
    setViewError(undefined);

    if (userMessage.attachments === undefined && trimmed.startsWith("/")) {
      try {
        const projectCommand = resolveProjectSlashCommand(
          trimmed,
          props.projectSlashCommands ?? [],
        );
        if (projectCommand !== undefined) {
          return submitAgentPrompt(
            {
              draft: createPromptDraft(projectCommand.prompt),
              userMessage: { role: "user", content: projectCommand.prompt },
            },
            signal,
          );
        }

        const command = parseSlashCommand(trimmed);
        setNotice(undefined);

        if (command.type === "view") {
          openFileView(command.filePath);
          return true;
        }
        if (command.type === "copy") {
          copyLastResponse();
          return true;
        }
        if (command.type === "status") {
          setShowStatus(true);
          return true;
        }
        if (command.type === "skills") {
          setShowSkills(true);
          return true;
        }
        if (command.type === "mcp") {
          setShowMcp(true);
          return true;
        }
        if (command.type === "compact") {
          setIsSessionOperation(true);
          void props.sessionController
            .compact()
            .then((result) => setNotice(formatContextCompactionNotice(result)))
            .catch((error: unknown) => {
              setNotice(formatContextCompactionFailureNotice(error));
            })
            .finally(() => setIsSessionOperation(false));
          return true;
        }
        if (command.type === "compact_retire") {
          setIsSessionOperation(true);
          void props.sessionController
            .retire()
            .then((result) => setNotice(formatContextRetirementNotice(result)))
            .catch((error: unknown) => {
              setNotice(formatContextRetirementFailureNotice(error));
            })
            .finally(() => setIsSessionOperation(false));
          return true;
        }
        if (command.type === "clear") {
          setIsSessionOperation(true);
          void props.sessionController
            .clear()
            .then(() => {
              const sessionId = props.sessionController.getBinding().sessionId;
              setGitBranchRefresh((current) => current + 1);
              setNotice(
                `Started new session ${sessionId}. Previous session remains available via /resume.`,
              );
            })
            .catch((error: unknown) => {
              setNotice(`Clear failed: ${errorMessage(error)}`);
            })
            .finally(() => setIsSessionOperation(false));
          return true;
        }
        if (command.type === "fork") {
          setIsSessionOperation(true);
          void props.sessionController
            .fork()
            .then((sessionId) => {
              setGitBranchRefresh((current) => current + 1);
              setNotice(
                `Cloned current session as ${sessionId}. Previous session remains available via /resume.`,
              );
            })
            .catch((error: unknown) => {
              setNotice(`Fork failed: ${errorMessage(error)}`);
            })
            .finally(() => setIsSessionOperation(false));
          return true;
        }
        if (command.type === "quit") {
          props.onQuit?.();
          exit();
          return true;
        }
        if (command.type === "model" || command.type === "model_switch") {
          if (!canSwitchModel) {
            setNotice(
              "Cannot switch models after the session has turns or while running.",
            );
            return false;
          }
          if (command.type === "model_switch") {
            const targetProfile = props.profiles?.profiles.get(command.profileName);
            if (targetProfile === undefined) {
              setNotice(`Unknown model profile: ${command.profileName}`);
              return false;
            }
            void doSwitchModel(targetProfile);
          } else {
            setModelPickerState({ isSwitching: false });
            setShowModelPicker(true);
          }
          return true;
        }
        if (command.type === "resume_list") {
          openResumePicker();
          return true;
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
      } catch (error) {
        setNotice(errorMessage(error));
        return false;
      }
      return true;
    }
    return submitAgentPrompt(submission, signal);
  };

  return (
    <Box flexDirection="column">
      {fileView?.status === "loading" ? (
        <FileViewerLoading filePath={fileView.filePath} onCancel={closeFileView} />
      ) : fileView?.status === "ready" ? (
        <FileViewer file={fileView.file} onClose={closeFileView} />
      ) : resumePicker?.status === "loading" ? (
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
          {showSkills ? (
            <Box marginTop={1}>
              <SkillsPanel snapshot={binding.skills()} />
            </Box>
          ) : null}
          {showMcp ? (
            <Box marginTop={1}>
              <McpPanel snapshot={binding.mcp()} />
            </Box>
          ) : null}
          <Box marginTop={1}>
            <Footer
              status={isCancelling ? "cancelling" : state.status}
              workedForMs={state.workedForMs}
            />
          </Box>
          <Box marginTop={1} flexDirection="column">
            {showModelPicker ? (
              <ModelPicker
                profiles={profileList}
                currentProfileName={binding.profileName}
                isSwitching={modelPickerState?.isSwitching}
                error={modelPickerState?.error}
                onCancel={closeModelPicker}
                onSelect={doSwitchModel}
              />
            ) : (
              <PromptInput
                modelName={binding.modelName}
                workspaceRoot={binding.workspaceRoot}
                gitBranch={gitBranch}
                contextUsage={state.contextUsage}
                isDisabled={isRunning || isSessionOperation || isCopying}
                history={props.history}
                commands={availableCommands}
                importImage={binding.importImage}
                verifyImageAssets={binding.verifyImageAssets}
                onSubmit={onSubmit}
                onMaintenance={onMaintenance}
                placeholder='Enter a coding request, or "/" for commands'
              />
            )}
            {viewError === undefined ? null : <Text color="red">{viewError}</Text>}
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

export function formatContextCompactionNotice(result: ContextCompactionResult): string {
  if (result.status === "unchanged") {
    if (result.outcome === "below_target") {
      return `Context is already below the compact target (${result.guardedTokensBefore.toLocaleString("en-US")} <= ${result.targetTokens.toLocaleString("en-US")} estimated tokens).`;
    }
    return "No eligible historical tool observations can be compacted.";
  }
  const before = result.guardedTokensBefore.toLocaleString("en-US");
  const after = result.guardedTokensAfter.toLocaleString("en-US");
  if (result.outcome === "insufficient_candidates") {
    return `Context compacted: ${result.addedOverrideCount} observations swapped, ${before} -> ${after} estimated tokens; target ${result.targetTokens.toLocaleString("en-US")} was not reached.`;
  }
  const reduction =
    result.guardedTokensBefore === 0
      ? "0.0"
      : (
          ((result.guardedTokensBefore - result.guardedTokensAfter) /
            result.guardedTokensBefore) *
          100
        ).toFixed(1);
  return `Context compacted: revision ${result.previousRevisionNumber} -> ${result.revisionNumber}, ${result.addedOverrideCount} observations swapped, ${before} -> ${after} estimated tokens (-${reduction}%).`;
}

export function formatContextCompactionFailureNotice(error: unknown): string {
  if (!(error instanceof ContextManagerError)) {
    return "Context compaction failed.";
  }
  const code = /^[A-Za-z0-9_]+$/.test(error.code)
    ? error.code
    : "CONTEXT_COMPACTION_FAILED";
  return `Context compaction failed at ${error.stage} (${code}).`;
}

export function formatContextRetirementNotice(result: ContextRetirementResult): string {
  if (result.status === "unchanged") {
    if (result.outcome === "below_target") {
      return `Context is already below the retirement target (${result.guardedTokensBefore.toLocaleString("en-US")} <= ${result.targetTokens.toLocaleString("en-US")} estimated tokens).`;
    }
    return "No complete cold prefix can be retired; the most recent 8 completed turns are protected.";
  }
  const before = result.guardedTokensBefore.toLocaleString("en-US");
  const after = result.guardedTokensAfter.toLocaleString("en-US");
  if (result.outcome === "retirement_floor") {
    return `Context prefix retired: revision ${result.previousRevisionNumber} -> ${result.revisionNumber}, ${result.retiredTurnCount} turns removed from the active request, ${before} -> ${after} estimated tokens; target ${result.targetTokens.toLocaleString("en-US")} was not reached. Run /compact first when retained tool output is still eligible. Older history remains available through Recall.`;
  }
  const reduction =
    result.guardedTokensBefore === 0
      ? "0.0"
      : (
          ((result.guardedTokensBefore - result.guardedTokensAfter) /
            result.guardedTokensBefore) *
          100
        ).toFixed(1);
  return `Context prefix retired: revision ${result.previousRevisionNumber} -> ${result.revisionNumber}, ${result.retiredTurnCount} turns removed from the active request, ${before} -> ${after} estimated tokens (-${reduction}%). Older history remains available through Recall.`;
}

export function formatContextRetirementFailureNotice(error: unknown): string {
  if (!(error instanceof ContextManagerError)) {
    return "Context prefix retirement failed.";
  }
  const code = /^[A-Za-z0-9_]+$/.test(error.code)
    ? error.code
    : "CONTEXT_RETIREMENT_FAILED";
  return `Context prefix retirement failed at ${error.stage} (${code}).`;
}
