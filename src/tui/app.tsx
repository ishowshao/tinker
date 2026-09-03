import { Box, Static, Text, useApp, useInput, useStdout, useWindowSize } from "ink";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { clearTerminal } from "ansi-escapes";
import { TurnCancelledError } from "../agent/turn-cancellation";
import { boundedMemoryError, type StoredMemorySummary } from "../memory/contracts";
import {
  ContextManagerError,
  type ContextCompactionResult,
  type ContextRetirementResult,
} from "../context/context-manager";
import { ContextBudgetExceededError } from "../model/model-request-preflight";
import { ModelRequestMediaAggregateError } from "../model/model-client";
import type { ReasoningEffortSnapshot } from "../model/reasoning-effort";
import type { SessionId } from "../ids/runtime-id";
import { readLastAssistantResponse } from "../session/session-last-response-reader";
import type { PromptHistory } from "./prompt-history";
import { Footer } from "./components/footer";
import { AssistantMarkdownProvider } from "./components/assistant-markdown";
import { ContextStatus } from "./components/context-status";
import { BackgroundTasks } from "./components/background-tasks";
import { BashConfirmation } from "./components/bash-confirmation";
import { Header } from "./components/header";
import { ModelPicker } from "./components/model-picker";
import { FileViewer, FileViewerLoading } from "./components/file-viewer";
import { MemoryBrowser } from "./components/memory-browser";
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
import {
  AssistantStreamSectionRow,
  Timeline,
  TimelineRow,
} from "./components/timeline";
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
import type { WorkspaceFileLister } from "./workspace-file-search";
import type { TurnUndoBarrierReason, TurnUndoResult } from "../tools/turn-undo-manager";
import {
  isAssistantStreamSectionItem,
  type TuiCommittedItem,
} from "./tui-projection-store";

export type AppProps = {
  sessionController: TuiSessionController;
  version?: string;
  readGitBranch?: (workspaceRoot: string) => Promise<string | undefined>;
  history?: PromptHistory;
  projectSlashCommands?: readonly ProjectSlashCommand[];
  fileLister?: WorkspaceFileLister;
  profiles?: ModelProfiles;
  persistDefaultProfile?: (profileName: string) => Promise<void>;
  readViewFile?: (workspaceRoot: string, filePath: string) => Promise<ViewFile>;
  readLastResponse?: (
    workspaceRoot: string,
    sessionId: SessionId,
  ) => Promise<string | undefined>;
  writeClipboard?: (markdown: string) => Promise<void>;
  onQuit?: () => void;
  initialNotice?: string;
  listStoredMemories?: () => readonly StoredMemorySummary[];
  memoryDisabledNotice?: string;
};

type ResumePickerState =
  | { status: "loading"; ownerSessionId: SessionId }
  | {
      status: "ready";
      ownerSessionId: SessionId;
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

const STATIC_HEADER = Symbol("tui-static-header");
const LIVE_TIMELINE_MAX_ROWS = 8;
const LIVE_TIMELINE_WITH_TASKS_MAX_ROWS = 3;
const BACKGROUND_TASKS_MAX_ROWS = 12;
const IDLE_PROMPT_SCHEDULER = Object.freeze({
  state: "idle" as const,
  pendingCount: 0,
});

export function App(props: AppProps) {
  const { exit } = useApp();
  const { write } = useStdout();
  const windowSize = useWindowSize();
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
  const log = useSyncExternalStore(
    binding.projectionStore.subscribe,
    binding.projectionStore.getLogSnapshot,
    binding.projectionStore.getLogSnapshot,
  );
  const bashGuard = useSyncExternalStore(
    (listener) => binding.subscribeBashGuard(listener),
    () => binding.bashGuard(),
    () => binding.bashGuard(),
  );
  const promptScheduler = useSyncExternalStore(
    (listener) => binding.subscribePromptScheduler?.(listener) ?? (() => undefined),
    () => binding.promptScheduler?.() ?? IDLE_PROMPT_SCHEDULER,
    () => binding.promptScheduler?.() ?? IDLE_PROMPT_SCHEDULER,
  );
  const [isRunning, setIsRunning] = useState(false);
  const executionRunning = isRunning || promptScheduler.state === "running";
  const [isSessionOperation, setIsSessionOperation] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(props.initialNotice);
  const currentQueuedFollowUpNotice = `Follow-up queued for the active turn (${promptScheduler.pendingCount} pending).`;
  const visibleNotice =
    notice?.startsWith("Follow-up queued for the active turn (") === true &&
    notice !== currentQueuedFollowUpNotice
      ? undefined
      : notice;
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
  const [memoryView, setMemoryView] = useState<
    readonly StoredMemorySummary[] | undefined
  >(undefined);
  const [viewError, setViewError] = useState<string | undefined>(undefined);
  const [staticRenderEpoch, setStaticRenderEpoch] = useState(0);
  const [gitBranch, setGitBranch] = useState<string | undefined>(undefined);
  const [gitBranchRefresh, setGitBranchRefresh] = useState(0);
  const gitBranchReadQueue = useRef<Promise<void>>(Promise.resolve());
  const activeController = useRef<AbortController | undefined>(undefined);
  const resumePickerRequest = useRef(0);
  const fileViewRequest = useRef(0);
  const beforeSessionCommit = useCallback(() => {
    write(clearTerminal);
  }, [write]);
  const restoreStaticViewport = useCallback(() => {
    write(clearTerminal);
    setStaticRenderEpoch((current) => current + 1);
  }, [write]);
  const staticItems = useMemo<Array<typeof STATIC_HEADER | TuiCommittedItem>>(
    () => [STATIC_HEADER, ...log.committed],
    [log.committed],
  );

  const canSwitchModel =
    state.recentTurns.length === 0 &&
    state.activeTurn === undefined &&
    props.profiles !== undefined &&
    props.profiles.profiles.size > 1;
  const reasoningEffort = binding.reasoningEffort?.();
  const hasReasoningEffort = reasoningEffort !== undefined;
  const activeResumePicker =
    resumePicker?.ownerSessionId === binding.sessionId ? resumePicker : undefined;

  const builtInCommands = SLASH_COMMANDS.filter(
    (command) =>
      (command.name !== "model" || canSwitchModel) &&
      (command.name !== "reasoning" || hasReasoningEffort),
  );
  const availableCommands = [...builtInCommands, ...(props.projectSlashCommands ?? [])];

  const profileList = props.profiles ? [...props.profiles.profiles.values()] : [];
  const cycleReasoningEffort = () => {
    const current = binding.reasoningEffort?.();
    if (current === undefined) {
      return;
    }
    const currentIndex = current.supportedEfforts.indexOf(current.effort);
    const nextIndex =
      currentIndex < 0 ? 0 : (currentIndex + 1) % current.supportedEfforts.length;
    const nextEffort = current.supportedEfforts[nextIndex];
    if (nextEffort === undefined) {
      return;
    }
    try {
      const updated = binding.setReasoningEffort?.(nextEffort);
      if (updated === undefined) {
        throw new Error("Reasoning effort control is unavailable.");
      }
      setNotice(
        `Reasoning effort cycled from ${JSON.stringify(current.effort)} to ${JSON.stringify(updated.effort)} (Ctrl+R).`,
      );
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

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
    { isActive: executionRunning },
  );

  const closeResumePicker = () => {
    const shouldRestoreViewport = activeResumePicker !== undefined;
    resumePickerRequest.current += 1;
    setResumePicker(undefined);
    setIsSessionOperation(false);
    setNotice(undefined);
    if (shouldRestoreViewport) {
      restoreStaticViewport();
    }
  };

  const openResumePicker = () => {
    const requestId = resumePickerRequest.current + 1;
    const ownerSessionId = binding.sessionId;
    resumePickerRequest.current = requestId;
    setNotice(undefined);
    setResumePicker({ status: "loading", ownerSessionId });
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
          restoreStaticViewport();
          return;
        }
        setResumePicker({
          status: "ready",
          ownerSessionId,
          sessions,
          isResuming: false,
        });
      })
      .catch((error: unknown) => {
        if (resumePickerRequest.current === requestId) {
          setResumePicker(undefined);
          setNotice(`Session operation failed: ${errorMessage(error)}`);
          restoreStaticViewport();
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
      .resume(session.sessionId, beforeSessionCommit)
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
    restoreStaticViewport();
  };

  const doSwitchModel = (profile: ModelProfile) => {
    setShowModelPicker(false);
    setModelPickerState(undefined);
    setNotice(undefined);
    setIsSessionOperation(true);
    void props.sessionController
      .switchModel(profile, beforeSessionCommit)
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
        restoreStaticViewport();
        setNotice(`Model switch failed: ${errorMessage(error)}`);
      })
      .finally(() => setIsSessionOperation(false));
  };

  const closeFileView = () => {
    fileViewRequest.current += 1;
    setFileView(undefined);
    restoreStaticViewport();
  };

  const closeMemoryView = () => {
    setMemoryView(undefined);
    restoreStaticViewport();
  };

  const openMemoryView = () => {
    if (props.listStoredMemories === undefined) {
      setNotice(props.memoryDisabledNotice ?? "memory disabled: not configured");
      return;
    }
    try {
      const snapshot = props.listStoredMemories();
      setNotice(undefined);
      setMemoryView(snapshot);
    } catch (error) {
      setNotice(`memory unavailable: ${boundedMemoryError(error)}`);
    }
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
          restoreStaticViewport();
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
    if (promptScheduler.state === "running") {
      if (submission.userMessage.attachments !== undefined) {
        setNotice("Active-turn follow-ups do not support image attachments.");
        return false;
      }
      if (submission.userMessage.content.trimStart().startsWith("/")) {
        setNotice("Slash commands cannot be queued while a turn is running.");
        return false;
      }
      try {
        const queued = binding.queueFollowUp?.(submission.userMessage);
        if (queued === undefined) {
          throw new Error("TUI session binding does not support follow-up queuing.");
        }
        void props.history?.append(submission.draft).catch((error: unknown) => {
          setNotice(`Prompt history write failed: ${errorMessage(error)}`);
        });
        setNotice(
          `Follow-up queued for the active turn (${queued.pendingCount} pending).`,
        );
        return true;
      } catch (error) {
        setNotice(`Follow-up was not queued: ${errorMessage(error)}`);
        return false;
      }
    }
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
      await props.sessionController.clear(beforeSessionCommit);
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
    const shouldRestoreViewport = showStatus || showSkills || showMcp;
    setShowStatus(false);
    setShowSkills(false);
    setShowMcp(false);
    setViewError(undefined);
    if (shouldRestoreViewport) {
      restoreStaticViewport();
    }

    if (promptScheduler.state === "running") {
      return submitAgentPrompt(submission, signal);
    }

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
        if (command.type === "memory") {
          openMemoryView();
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
        if (command.type === "yolo_status") {
          setNotice(`Bash guard: ${bashGuard.mode} (source: ${bashGuard.source}).`);
          return true;
        }
        if (command.type === "yolo") {
          binding.setYoloMode(command.enabled);
          setNotice(
            command.enabled
              ? "YOLO enabled for this session; dangerous Bash commands will run without confirmation."
              : "YOLO disabled; dangerous Bash commands require confirmation.",
          );
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
        if (command.type === "undo") {
          setIsSessionOperation(true);
          void props.sessionController
            .undo()
            .then((result) => {
              if (result.status === "restored" || result.status === "incomplete") {
                setGitBranchRefresh((current) => current + 1);
              }
              setNotice(formatTurnUndoNotice(result));
            })
            .catch((error: unknown) => {
              setNotice(errorMessage(error));
            })
            .finally(() => setIsSessionOperation(false));
          return true;
        }
        if (command.type === "clear") {
          setIsSessionOperation(true);
          void props.sessionController
            .clear(beforeSessionCommit)
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
            .fork(beforeSessionCommit)
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
        if (
          command.type === "reasoning_status" ||
          command.type === "reasoning_reset" ||
          command.type === "reasoning_set"
        ) {
          const current = binding.reasoningEffort?.();
          if (current === undefined) {
            setNotice("Current model profile does not configure reasoning effort.");
            return false;
          }
          try {
            if (command.type === "reasoning_status") {
              setNotice(formatReasoningEffortStatus(current));
            } else if (command.type === "reasoning_reset") {
              const reset = binding.resetReasoningEffort?.();
              if (reset === undefined) {
                throw new Error("Reasoning effort control is unavailable.");
              }
              setNotice(
                `Reasoning effort reset to profile default ${JSON.stringify(reset.defaultEffort)}.`,
              );
            } else {
              const updated = binding.setReasoningEffort?.(command.effort);
              if (updated === undefined) {
                throw new Error("Reasoning effort control is unavailable.");
              }
              setNotice(
                `Reasoning effort set to ${JSON.stringify(updated.effort)} for this session runtime (profile default: ${JSON.stringify(updated.defaultEffort)}).`,
              );
            }
          } catch (error) {
            setNotice(errorMessage(error));
            return false;
          }
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
                .resume(command.sessionId, beforeSessionCommit)
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
    <AssistantMarkdownProvider>
      <Box flexDirection="column">
        <Static key={`${binding.sessionId}:${staticRenderEpoch}`} items={staticItems}>
          {(item) =>
            item === STATIC_HEADER ? (
              <Header
                key={`header-${binding.sessionId}`}
                modelName={binding.modelName}
                workspaceRoot={binding.workspaceRoot}
                sessionId={binding.sessionId}
              />
            ) : isAssistantStreamSectionItem(item) ? (
              <AssistantStreamSectionRow key={item.id} item={item} />
            ) : (
              <TimelineRow key={item.id} item={item} />
            )
          }
        </Static>
        {fileView?.status === "loading" ? (
          <FileViewerLoading filePath={fileView.filePath} onCancel={closeFileView} />
        ) : fileView?.status === "ready" ? (
          <FileViewer file={fileView.file} onClose={closeFileView} />
        ) : memoryView !== undefined ? (
          <MemoryBrowser memories={memoryView} onClose={closeMemoryView} />
        ) : activeResumePicker?.status === "loading" ? (
          <ResumeSessionPickerLoading onCancel={closeResumePicker} />
        ) : activeResumePicker?.status === "ready" ? (
          <ResumeSessionPicker
            sessions={activeResumePicker.sessions}
            isResuming={activeResumePicker.isResuming}
            error={activeResumePicker.error}
            onCancel={closeResumePicker}
            onSelect={resumeSelectedSession}
          />
        ) : (
          <Box
            flexDirection="column"
            maxHeight={Math.max(1, windowSize.rows - 1)}
            overflow="hidden"
          >
            <Box flexDirection="column" flexShrink={1} minHeight={0} overflow="hidden">
              <Box flexDirection="column" flexShrink={0}>
                <Box marginTop={1} flexDirection="column" flexShrink={0}>
                  <Box
                    maxHeight={
                      state.backgroundTasks.length === 0
                        ? LIVE_TIMELINE_MAX_ROWS
                        : LIVE_TIMELINE_WITH_TASKS_MAX_ROWS
                    }
                    overflow="hidden"
                  >
                    <Timeline items={log.live} />
                  </Box>
                </Box>
                {state.backgroundTasks.length === 0 ? null : (
                  <Box
                    marginTop={1}
                    maxHeight={BACKGROUND_TASKS_MAX_ROWS}
                    overflow="hidden"
                    flexShrink={0}
                  >
                    <BackgroundTasks tasks={state.backgroundTasks} />
                  </Box>
                )}
                {showStatus ? (
                  <Box marginTop={1} flexShrink={0}>
                    <ContextStatus state={state} bashGuard={bashGuard} />
                  </Box>
                ) : null}
                {showSkills ? (
                  <Box marginTop={1} flexShrink={0}>
                    <SkillsPanel snapshot={binding.skills()} />
                  </Box>
                ) : null}
                {showMcp ? (
                  <Box marginTop={1} flexShrink={0}>
                    <McpPanel snapshot={binding.mcp()} />
                  </Box>
                ) : null}
              </Box>
            </Box>
            <Box marginTop={1} flexShrink={0}>
              <Footer
                status={
                  isCancelling
                    ? "cancelling"
                    : executionRunning
                      ? "running"
                      : state.status
                }
                workedForMs={state.workedForMs}
                yolo={bashGuard.mode === "yolo"}
                pendingFollowUps={promptScheduler.pendingCount}
              />
            </Box>
            <Box marginTop={1} flexDirection="column" flexShrink={0}>
              {bashGuard.pending !== undefined ? (
                <BashConfirmation
                  command={bashGuard.pending.command}
                  reason={bashGuard.pending.reason}
                  onDecision={(decision) => {
                    void binding
                      .resolveBashConfirmation(decision)
                      .catch((error: unknown) =>
                        setNotice(`Bash confirmation failed: ${errorMessage(error)}`),
                      );
                  }}
                />
              ) : showModelPicker ? (
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
                  reasoningEffort={reasoningEffort?.effort}
                  version={props.version}
                  workspaceRoot={binding.workspaceRoot}
                  gitBranch={gitBranch}
                  contextUsage={state.contextUsage}
                  isDisabled={
                    isSessionOperation ||
                    isCopying ||
                    isCancelling ||
                    bashGuard.pending !== undefined
                  }
                  history={props.history}
                  commands={availableCommands}
                  fileLister={props.fileLister}
                  importImage={
                    promptScheduler.state === "running"
                      ? undefined
                      : binding.importImage
                  }
                  verifyImageAssets={binding.verifyImageAssets}
                  onCycleReasoningEffort={
                    hasReasoningEffort && promptScheduler.state !== "running"
                      ? cycleReasoningEffort
                      : undefined
                  }
                  onSubmit={onSubmit}
                  onMaintenance={onMaintenance}
                  placeholder={
                    promptScheduler.state === "running"
                      ? "Send a follow-up for the active turn…"
                      : 'Enter a coding request, or "/" for commands'
                  }
                />
              )}
              {viewError === undefined ? null : <Text color="red">{viewError}</Text>}
              {visibleNotice === undefined ? null : (
                <Text color="yellow">{visibleNotice}</Text>
              )}
            </Box>
          </Box>
        )}
      </Box>
    </AssistantMarkdownProvider>
  );
}

function formatReasoningEffortStatus(snapshot: ReasoningEffortSnapshot): string {
  const source =
    snapshot.source === "profile_default"
      ? "profile default"
      : `session override; profile default: ${snapshot.defaultEffort}`;
  return `Reasoning effort: ${snapshot.effort} (${source}). Available: ${snapshot.supportedEfforts.join(", ")}.`;
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

export function formatTurnUndoNotice(result: TurnUndoResult): string {
  if (result.status === "nothing") {
    return "Nothing to undo in this active session.";
  }
  if (result.status === "unavailable") {
    return `Cannot undo turn ${result.turnNumber}: ${formatUndoBarrierReason(result.reason)}`;
  }
  if (result.status === "refused") {
    const count = result.conflicts.length;
    return [
      `Undo refused: ${count} ${count === 1 ? "file" : "files"} changed after turn ${result.turnNumber}.`,
      ...result.conflicts.map(
        (conflict) => `- ${conflict.displayPath}: ${conflict.detail}`,
      ),
    ].join("\n");
  }
  if (result.status === "incomplete") {
    return `Undo incomplete for turn ${result.turnNumber}: ${formatPartialUndoCount(result)} before ${result.failedPath} failed: ${sentenceDetail(result.detail)}\nRun /undo again to retry.`;
  }
  return `Restored workspace to before turn ${result.turnNumber}: ${formatFileCount(result.restoredFileCount)} restored, ${formatFileCount(result.deletedFileCount)} deleted.`;
}

function formatUndoBarrierReason(reason: TurnUndoBarrierReason): string {
  if (reason.kind === "file-too-large" || reason.kind === "turn-too-large") {
    return "undo snapshot capacity was exceeded.";
  }
  return `undo snapshot could not be captured for ${reason.displayPath}: ${sentenceDetail(reason.detail)}`;
}

function formatPartialUndoCount(
  result: Extract<TurnUndoResult, { status: "incomplete" }>,
): string {
  const completed: string[] = [];
  if (result.restoredFileCount > 0) {
    completed.push(`${formatFileCount(result.restoredFileCount)} restored`);
  }
  if (result.deletedFileCount > 0) {
    completed.push(`${formatFileCount(result.deletedFileCount)} deleted`);
  }
  return completed.length === 0 ? "no files restored" : completed.join(" and ");
}

function formatFileCount(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

function sentenceDetail(detail: string): string {
  return /[.!?]$/.test(detail) ? detail : `${detail}.`;
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
    return `Context prefix retired: revision ${result.previousRevisionNumber} -> ${result.revisionNumber}, ${result.retiredTurnCount} turns removed from the active request, ${before} -> ${after} estimated tokens; target ${result.targetTokens.toLocaleString("en-US")} was not reached. Run /compact first when retained tool output is still eligible. Older history remains available through RecallSearch and RecallGet.`;
  }
  const reduction =
    result.guardedTokensBefore === 0
      ? "0.0"
      : (
          ((result.guardedTokensBefore - result.guardedTokensAfter) /
            result.guardedTokensBefore) *
          100
        ).toFixed(1);
  return `Context prefix retired: revision ${result.previousRevisionNumber} -> ${result.revisionNumber}, ${result.retiredTurnCount} turns removed from the active request, ${before} -> ${after} estimated tokens (-${reduction}%). Older history remains available through RecallSearch and RecallGet.`;
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
