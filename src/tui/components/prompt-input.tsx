import os from "node:os";
import path from "node:path";
import { Box, Text, useInput, usePaste } from "ink";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ContextUsageSnapshot } from "../../agent/context-meter";
import type { UserMessage } from "../../agent/types";
import { ModelRequestMediaAggregateError } from "../../model/model-client";
import { ImageNotRecognizedError } from "../../image/image-probe";
import type { ImportedImageAsset } from "../../image/image-asset-store";
import type { ImageAssetRef } from "../../image/image-types";
import { runtimeIdFactory, type RuntimeIdFactory } from "../../ids/runtime-id";
import {
  formatContextUsageLine,
  formatLatestProviderCacheRate,
} from "../context-format";
import {
  type FileMentionMatch,
  findFileMention,
  rankWorkspaceFiles,
} from "../file-mention";
import {
  restorePromptHistoryEntry,
  type LoadedPromptHistoryRecord,
} from "../prompt-history";
import {
  backspaceDraft,
  createPromptDraft,
  deleteForwardDraft,
  deleteToLineStartDraft,
  draftSubmissionSnapshot,
  insertDraftImage,
  insertDraftText,
  moveDraftDown,
  moveDraftLeft,
  moveDraftRight,
  moveDraftToLineEnd,
  moveDraftToLineStart,
  moveDraftUp,
  promptDraftChanged,
  replaceDraftText,
  type PromptDraft,
} from "../prompt-draft";
import { matchSlashCommands, type SlashCommand } from "../slash-commands";
import { listWorkspaceFiles, type WorkspaceFileLister } from "../workspace-file-search";

export type PromptSubmission = {
  readonly draft: PromptDraft;
  readonly userMessage: UserMessage;
};

export type PromptMaintenanceAction = "compact" | "retire" | "new_session";

export type PromptSubmissionOutcome =
  | boolean
  | {
      readonly kind: "maintenance_offer";
      readonly reason: "budget" | "media_aggregate";
      readonly message: string;
    };

export type PromptInputProps = {
  modelName: string;
  reasoningEffort?: string;
  workspaceRoot: string;
  gitBranch?: string;
  contextUsage?: ContextUsageSnapshot;
  isDisabled?: boolean;
  placeholder?: string;
  history?: {
    records?: readonly LoadedPromptHistoryRecord[];
    entries?: readonly string[];
  };
  commands?: readonly SlashCommand[];
  fileLister?: WorkspaceFileLister;
  idFactory?: Pick<RuntimeIdFactory, "createImageAttachmentId">;
  importImage?: (
    sourcePath: string,
    signal: AbortSignal,
    prospectiveMessageImageCount: number,
  ) => Promise<ImportedImageAsset>;
  verifyImageAssets?: (
    assets: readonly ImageAssetRef[],
    signal: AbortSignal,
  ) => Promise<void>;
  onCycleReasoningEffort?: () => void;
  onSubmit: (
    submission: PromptSubmission,
    signal: AbortSignal,
  ) => PromptSubmissionOutcome | Promise<PromptSubmissionOutcome>;
  onMaintenance?: (
    action: PromptMaintenanceAction,
    signal: AbortSignal,
  ) => void | Promise<void>;
};

type HistoryNavigation = {
  index: number;
  originalDraft: PromptDraft;
  browsing: boolean;
};

type PromptInputPhase =
  | { kind: "idle" }
  | { kind: "attaching"; operationId: string }
  | { kind: "restoring_history"; operationId: string; targetIndex: number }
  | { kind: "admitting"; submissionId: string }
  | {
      kind: "maintenance_offer";
      reason: "budget" | "media_aggregate";
      operationId?: string;
      action?: PromptMaintenanceAction;
    };

type PromptInputState = {
  draft: PromptDraft;
  navigation?: HistoryNavigation;
  suggestionIndex: number;
  suggestionsDismissed: boolean;
  phase: PromptInputPhase;
  error?: string;
};

type FileCatalogState =
  | { status: "idle" }
  | { status: "ready"; files: readonly string[] }
  | { status: "error"; message: string };

function createPromptInputState(value = ""): PromptInputState {
  return {
    draft: createPromptDraft(value),
    suggestionIndex: 0,
    suggestionsDismissed: false,
    phase: { kind: "idle" },
  };
}

export function PromptInput(props: PromptInputProps) {
  const [state, setState] = useState<PromptInputState>(createPromptInputState);
  const [fileCatalog, setFileCatalog] = useState<FileCatalogState>({
    status: "idle",
  });
  const operation = useRef<AbortController | undefined>(undefined);
  const idFactory = props.idFactory ?? runtimeIdFactory;
  const locked = props.isDisabled === true || state.phase.kind !== "idle";

  useEffect(
    () => () => {
      operation.current?.abort();
    },
    [],
  );

  const fileMention =
    state.suggestionsDismissed || state.navigation?.browsing === true
      ? undefined
      : findFileMention(state.draft.editor);
  const filePopupActive = fileMention !== undefined && !locked;
  const fileLister = props.fileLister ?? listWorkspaceFiles;

  useEffect(() => {
    if (!filePopupActive) {
      return;
    }
    const controller = new AbortController();
    void fileLister(props.workspaceRoot, controller.signal).then(
      (files) => {
        if (!controller.signal.aborted) {
          setFileCatalog({ status: "ready", files });
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setFileCatalog({ status: "error", message: errorMessage(error) });
        }
      },
    );
    return () => controller.abort();
  }, [fileLister, filePopupActive, props.workspaceRoot]);

  const fileQuery = fileMention?.query;
  const fileMatches = useMemo(
    () =>
      fileQuery === undefined || fileCatalog.status !== "ready"
        ? []
        : rankWorkspaceFiles(fileCatalog.files, fileQuery),
    [fileCatalog, fileQuery],
  );
  const suggestions =
    state.suggestionsDismissed || filePopupActive || state.draft.attachments.length > 0
      ? []
      : matchSlashCommands(state.draft.editor.value, props.commands);
  const suggestionCount = filePopupActive ? fileMatches.length : suggestions.length;
  const selectedIndex =
    suggestionCount === 0 ? 0 : Math.min(state.suggestionIndex, suggestionCount - 1);

  const updateDraft = (update: (draft: PromptDraft) => PromptDraft) => {
    setState((current) => {
      if (current.phase.kind !== "idle") {
        return current;
      }
      const draft = update(current.draft);
      return promptDraftChanged(current.draft, draft)
        ? applyDraftChange(current, draft)
        : current;
    });
  };

  const insertFilePath = (filePath: string) => {
    setState((current) => {
      const mention = findFileMention(current.draft.editor);
      if (mention === undefined || current.phase.kind !== "idle") {
        return current;
      }
      return applyDraftChange(
        current,
        replaceDraftText(
          current.draft,
          { start: mention.start, end: mention.end },
          fileMentionReplacement(current.draft.editor.value, mention.end, filePath),
        ),
      );
    });
  };

  const selectFile = (filePath: string) => {
    const mention = findFileMention(state.draft.editor);
    if (mention === undefined || locked) {
      return;
    }
    const importImage = props.importImage;
    if (importImage === undefined) {
      insertFilePath(filePath);
      return;
    }
    const controller = new AbortController();
    const operationId = crypto.randomUUID();
    operation.current?.abort();
    operation.current = controller;
    const captured = state.draft;
    setState((current) => ({
      ...current,
      phase: { kind: "attaching", operationId },
      error: undefined,
    }));
    void Promise.resolve()
      .then(() =>
        importImage(filePath, controller.signal, captured.attachments.length + 1),
      )
      .then((imported) => {
        setState((current) => {
          if (
            current.phase.kind !== "attaching" ||
            current.phase.operationId !== operationId
          ) {
            return current;
          }
          if (controller.signal.aborted) {
            return { ...current, phase: { kind: "idle" } };
          }
          try {
            const draft = insertDraftImage(captured, {
              replace: { start: mention.start, end: mention.end },
              attachmentId: idFactory.createImageAttachmentId(),
              imported,
            });
            return {
              ...applyDraftChange(current, draft),
              phase: { kind: "idle" },
              error: undefined,
            };
          } catch (error) {
            return {
              ...current,
              phase: { kind: "idle" },
              error: errorMessage(error),
            };
          }
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          setState((current) =>
            current.phase.kind === "attaching" &&
            current.phase.operationId === operationId
              ? { ...current, phase: { kind: "idle" } }
              : current,
          );
          return;
        }
        if (error instanceof ImageNotRecognizedError) {
          setState((current) => {
            if (
              current.phase.kind !== "attaching" ||
              current.phase.operationId !== operationId
            ) {
              return current;
            }
            return {
              ...applyDraftChange(
                current,
                replaceDraftText(
                  captured,
                  { start: mention.start, end: mention.end },
                  fileMentionReplacement(captured.editor.value, mention.end, filePath),
                ),
              ),
              phase: { kind: "idle" },
            };
          });
          return;
        }
        if (error instanceof ModelRequestMediaAggregateError) {
          setState((current) =>
            current.phase.kind === "attaching" &&
            current.phase.operationId === operationId
              ? {
                  ...current,
                  phase: {
                    kind: "maintenance_offer",
                    reason: "media_aggregate",
                  },
                  error: error.message,
                }
              : current,
          );
          return;
        }
        setState((current) =>
          current.phase.kind === "attaching" &&
          current.phase.operationId === operationId
            ? {
                ...current,
                phase: { kind: "idle" },
                error: `Image attachment failed: ${errorMessage(error)}`,
              }
            : current,
        );
      })
      .finally(() => {
        if (operation.current === controller) {
          operation.current = undefined;
        }
      });
  };

  const submitDraft = (draft: PromptDraft) => {
    if (locked) {
      return;
    }
    let submission: PromptSubmission;
    try {
      const snapshot = draftSubmissionSnapshot(draft);
      submission = { draft: snapshot.draft, userMessage: snapshot.userMessage };
    } catch (error) {
      setState((current) => ({ ...current, error: errorMessage(error) }));
      return;
    }
    const controller = new AbortController();
    const submissionId = crypto.randomUUID();
    operation.current?.abort();
    operation.current = controller;
    setState((current) => ({
      ...current,
      phase: { kind: "admitting", submissionId },
      error: undefined,
    }));
    void Promise.resolve(props.onSubmit(submission, controller.signal))
      .then((outcome) => {
        setState((current) => {
          if (
            current.phase.kind !== "admitting" ||
            current.phase.submissionId !== submissionId
          ) {
            return current;
          }
          if (outcome === true) return createPromptInputState();
          if (typeof outcome === "object" && outcome.kind === "maintenance_offer") {
            return {
              ...current,
              phase: {
                kind: "maintenance_offer",
                reason: outcome.reason,
              },
              error: outcome.message,
            };
          }
          return { ...current, phase: { kind: "idle" } };
        });
      })
      .catch((error: unknown) => {
        setState((current) =>
          current.phase.kind === "admitting" &&
          current.phase.submissionId === submissionId
            ? {
                ...current,
                phase: { kind: "idle" },
                error: errorMessage(error),
              }
            : current,
        );
      })
      .finally(() => {
        if (operation.current === controller) {
          operation.current = undefined;
        }
      });
  };

  const navigateHistory = (direction: "up" | "down") => {
    const records = historyRecords(props.history);
    if (records.length === 0 || locked) {
      return;
    }
    const currentNavigation = state.navigation;
    if (direction === "down" && currentNavigation === undefined) {
      return;
    }
    if (
      direction === "down" &&
      currentNavigation !== undefined &&
      currentNavigation.index >= records.length - 1
    ) {
      setState({
        ...state,
        draft: currentNavigation.originalDraft,
        navigation: undefined,
        suggestionIndex: 0,
        suggestionsDismissed: false,
        error: undefined,
      });
      return;
    }
    const targetIndex =
      currentNavigation === undefined
        ? records.length - 1
        : direction === "up"
          ? Math.max(0, currentNavigation.index - 1)
          : Math.min(records.length - 1, currentNavigation.index + 1);
    const record = records[targetIndex];
    if (record === undefined) {
      return;
    }
    const navigation: HistoryNavigation = {
      index: targetIndex,
      originalDraft: currentNavigation?.originalDraft ?? state.draft,
      browsing: true,
    };
    if (record.kind === "invalid") {
      setState({
        ...state,
        navigation,
        suggestionsDismissed: true,
        error: `Prompt history line ${record.lineNumber} is invalid (${record.errorCode}).`,
      });
      return;
    }
    if (record.entry.version === 1) {
      setState({
        ...state,
        draft: restorePromptHistoryEntry(record.entry, idFactory),
        navigation,
        suggestionsDismissed: true,
        suggestionIndex: 0,
        error: undefined,
      });
      return;
    }
    if (props.verifyImageAssets === undefined) {
      setState({
        ...state,
        navigation,
        error: "Current model profile cannot restore image Prompt history.",
      });
      return;
    }
    const controller = new AbortController();
    const operationId = crypto.randomUUID();
    operation.current?.abort();
    operation.current = controller;
    setState({
      ...state,
      phase: { kind: "restoring_history", operationId, targetIndex },
      error: undefined,
    });
    void props
      .verifyImageAssets(
        record.entry.attachments.map((attachment) => attachment.asset),
        controller.signal,
      )
      .then(() => {
        setState((current) => {
          if (
            current.phase.kind !== "restoring_history" ||
            current.phase.operationId !== operationId
          ) {
            return current;
          }
          if (controller.signal.aborted) {
            return { ...current, phase: { kind: "idle" } };
          }
          return {
            ...current,
            draft: restorePromptHistoryEntry(record.entry, idFactory),
            navigation,
            phase: { kind: "idle" },
            suggestionsDismissed: true,
            suggestionIndex: 0,
          };
        });
      })
      .catch((error: unknown) => {
        setState((current) =>
          current.phase.kind === "restoring_history" &&
          current.phase.operationId === operationId
            ? controller.signal.aborted
              ? { ...current, phase: { kind: "idle" } }
              : {
                  ...current,
                  navigation,
                  phase: { kind: "idle" },
                  error: `Prompt history restore failed: ${errorMessage(error)}`,
                }
            : current,
        );
      })
      .finally(() => {
        if (operation.current === controller) {
          operation.current = undefined;
        }
      });
  };

  useInput(
    (input, key) => {
      if (state.phase.kind === "maintenance_offer") {
        if (state.phase.operationId !== undefined) {
          return;
        }
        if (key.escape) {
          setState((current) => ({
            ...current,
            phase: { kind: "idle" },
            error: undefined,
          }));
          return;
        }
        const action = maintenanceAction(input);
        if (action === undefined) return;
        if (props.onMaintenance === undefined) {
          setState((current) => ({
            ...current,
            error: "Prompt maintenance actions are unavailable.",
          }));
          return;
        }
        const controller = new AbortController();
        const operationId = crypto.randomUUID();
        operation.current?.abort();
        operation.current = controller;
        setState((current) =>
          current.phase.kind === "maintenance_offer"
            ? {
                ...current,
                phase: {
                  ...current.phase,
                  operationId,
                  action,
                },
                error: undefined,
              }
            : current,
        );
        void Promise.resolve(props.onMaintenance(action, controller.signal))
          .then(() => {
            setState((current) =>
              current.phase.kind === "maintenance_offer" &&
              current.phase.operationId === operationId
                ? { ...current, phase: { kind: "idle" } }
                : current,
            );
          })
          .catch((error: unknown) => {
            setState((current) =>
              current.phase.kind === "maintenance_offer" &&
              current.phase.operationId === operationId
                ? {
                    ...current,
                    phase: {
                      kind: "maintenance_offer",
                      reason: current.phase.reason,
                    },
                    error: `Maintenance failed: ${errorMessage(error)}`,
                  }
                : current,
            );
          })
          .finally(() => {
            if (operation.current === controller) {
              operation.current = undefined;
            }
          });
        return;
      }
      if (state.phase.kind !== "idle") {
        if (key.escape) {
          operation.current?.abort();
        }
        return;
      }
      if (key.ctrl && input === "r") {
        props.onCycleReasoningEffort?.();
        return;
      }
      const selectedFile = fileMatches[selectedIndex];
      const selectedCommand = suggestions[selectedIndex];
      if (key.return) {
        if (filePopupActive && selectedFile !== undefined) {
          selectFile(selectedFile.path);
        } else if (selectedCommand !== undefined) {
          submitDraft(createPromptDraft(`/${selectedCommand.name}`));
        } else {
          submitDraft(state.draft);
        }
        return;
      }
      if (key.tab) {
        if (filePopupActive) {
          if (selectedFile === undefined) {
            setState((current) => ({ ...current, suggestionsDismissed: true }));
          } else {
            selectFile(selectedFile.path);
          }
        } else if (selectedCommand !== undefined) {
          setState(createPromptInputState(`/${selectedCommand.name} `));
        }
        return;
      }
      if (key.escape) {
        if (filePopupActive || suggestions.length > 0) {
          setState((current) => ({ ...current, suggestionsDismissed: true }));
        }
        return;
      }
      if (key.upArrow && filePopupActive) {
        if (fileMatches.length > 0) {
          setState((current) => ({
            ...current,
            suggestionIndex:
              (selectedIndex + fileMatches.length - 1) % fileMatches.length,
          }));
        }
        return;
      }
      if (key.downArrow && filePopupActive) {
        if (fileMatches.length > 0) {
          setState((current) => ({
            ...current,
            suggestionIndex: (selectedIndex + 1) % fileMatches.length,
          }));
        }
        return;
      }
      if (key.upArrow && suggestions.length > 0) {
        setState((current) => ({
          ...current,
          suggestionIndex:
            (selectedIndex + suggestions.length - 1) % suggestions.length,
        }));
        return;
      }
      if (key.downArrow && suggestions.length > 0) {
        setState((current) => ({
          ...current,
          suggestionIndex: (selectedIndex + 1) % suggestions.length,
        }));
        return;
      }
      if (key.upArrow) {
        if (state.navigation !== undefined) {
          navigateHistory("up");
          return;
        }
        const moved = moveDraftUp(state.draft);
        if (promptDraftChanged(state.draft, moved)) {
          updateDraft(() => moved);
        } else {
          navigateHistory("up");
        }
        return;
      }
      if (key.downArrow) {
        if (state.navigation?.browsing === true) {
          navigateHistory("down");
          return;
        }
        const moved = moveDraftDown(state.draft);
        if (promptDraftChanged(state.draft, moved)) {
          updateDraft(() => moved);
        } else {
          navigateHistory("down");
        }
        return;
      }
      if (key.leftArrow) {
        updateDraft(moveDraftLeft);
      } else if (key.rightArrow) {
        updateDraft(moveDraftRight);
      } else if (key.backspace) {
        updateDraft(backspaceDraft);
      } else if (key.delete) {
        updateDraft(deleteForwardDraft);
      } else if (key.ctrl) {
        if (input === "a") updateDraft(moveDraftToLineStart);
        else if (input === "e") updateDraft(moveDraftToLineEnd);
        else if (input === "d") updateDraft(deleteForwardDraft);
        else if (input === "u") updateDraft(deleteToLineStartDraft);
      } else if (!key.meta && !key.pageUp && !key.pageDown && input !== "") {
        updateDraft((draft) => insertDraftText(draft, normalizeLineBreaks(input)));
      }
    },
    { isActive: props.isDisabled !== true },
  );

  usePaste(
    (text) => {
      updateDraft((draft) => insertDraftText(draft, normalizeLineBreaks(text)));
    },
    { isActive: !locked },
  );

  const showFileSuggestions = filePopupActive;
  const showSlashSuggestions = suggestions.length > 0 && !locked;
  const showSuggestions = showFileSuggestions || showSlashSuggestions;
  const cacheRate = formatLatestProviderCacheRate(
    props.contextUsage?.lastProviderUsage,
  );
  return (
    <Box flexDirection="column">
      <Box width="100%" borderStyle="single" borderLeft={false} borderRight={false}>
        {renderDraft(state.draft, props, locked)}
      </Box>
      {showSuggestions ? null : (
        <Box>
          <Text dimColor>
            {props.modelName}
            {props.reasoningEffort === undefined ? null : ` ${props.reasoningEffort}`} ·{" "}
            {formatWorkspacePath(props.workspaceRoot)}
            {props.gitBranch === undefined ? null : ` · ${props.gitBranch}`}
            {state.phase.kind === "idle" ? null : ` · ${phaseLabel(state.phase)}`}
          </Text>
          {props.contextUsage === undefined ? null : (
            <>
              <Text dimColor> · </Text>
              <Text
                color={contextColor(props.contextUsage.pressure)}
                dimColor={props.contextUsage.pressure === "normal"}
              >
                {formatContextUsageLine(props.contextUsage)}
              </Text>
            </>
          )}
          {cacheRate === undefined ? null : (
            <>
              <Text dimColor> · </Text>
              <Text dimColor>{cacheRate}</Text>
            </>
          )}
        </Box>
      )}
      {showFileSuggestions ? (
        renderFileSuggestions(fileCatalog, fileMatches, selectedIndex)
      ) : showSlashSuggestions ? (
        <Box flexDirection="column">
          {suggestions.map((command, index) => (
            <Text key={command.name}>
              {index === selectedIndex ? "❯ " : "  "}/{command.name}
              <Text dimColor> {command.description}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
      {state.error === undefined ? null : <Text color="red">{state.error}</Text>}
      {state.phase.kind === "maintenance_offer" ? (
        <Text color="yellow">
          {state.phase.operationId === undefined
            ? "Context maintenance: c compact · r compact retire · n new session · Esc edit"
            : `Running ${maintenanceLabel(state.phase.action)}…`}
        </Text>
      ) : null}
    </Box>
  );
}

function applyDraftChange(
  state: PromptInputState,
  draft: PromptDraft,
): PromptInputState {
  const valueChanged = state.draft.editor.value !== draft.editor.value;
  return {
    ...state,
    draft,
    navigation: valueChanged
      ? undefined
      : state.navigation === undefined
        ? undefined
        : { ...state.navigation, browsing: false },
    suggestionIndex: valueChanged ? 0 : state.suggestionIndex,
    suggestionsDismissed: valueChanged ? false : state.suggestionsDismissed,
    error: undefined,
  };
}

function historyRecords(
  history: PromptInputProps["history"],
): readonly LoadedPromptHistoryRecord[] {
  if (history?.records !== undefined) {
    return history.records;
  }
  return (history?.entries ?? []).map((text, index) => ({
    kind: "valid",
    lineNumber: index + 1,
    entry: { version: 1, text },
  }));
}

function renderDraft(draft: PromptDraft, props: PromptInputProps, disabled: boolean) {
  if (draft.editor.value === "") {
    const placeholder = props.placeholder ?? "";
    if (disabled) return <Text dimColor>{placeholder}</Text>;
    if (placeholder === "") return <Text inverse> </Text>;
    return (
      <Text>
        <Text inverse>{placeholder.slice(0, 1)}</Text>
        <Text dimColor>{placeholder.slice(1)}</Text>
      </Text>
    );
  }
  const chars = [...draft.editor.value];
  const elements = new Map(
    draft.elements.map((element) => [element.range.start, element]),
  );
  const nodes: React.ReactNode[] = [];
  for (let index = 0; index <= chars.length; ) {
    const element = elements.get(index);
    if (element !== undefined) {
      nodes.push(
        <Text
          key={`image-${element.attachmentId}`}
          color="cyan"
          bold
          inverse={!disabled && draft.editor.cursor === element.range.start}
        >
          {element.label}
        </Text>,
      );
      index = element.range.end;
      continue;
    }
    if (index === chars.length) {
      if (!disabled && draft.editor.cursor === index) {
        nodes.push(
          <Text key="cursor-end" inverse>
            {" "}
          </Text>,
        );
      }
      break;
    }
    const char = chars[index];
    if (!disabled && draft.editor.cursor === index) {
      nodes.push(
        <Fragment key={`cursor-${index}`}>
          <Text inverse>{char === "\n" ? " " : char}</Text>
          {char === "\n" ? "\n" : null}
        </Fragment>,
      );
    } else {
      nodes.push(<Fragment key={`char-${index}`}>{char}</Fragment>);
    }
    index += 1;
  }
  return <Text>{nodes}</Text>;
}

function renderFileSuggestions(
  catalog: FileCatalogState,
  matches: readonly FileMentionMatch[],
  selectedIndex: number,
) {
  if (catalog.status === "idle")
    return <Text dimColor>Searching workspace files…</Text>;
  if (catalog.status === "error") return <Text color="red">{catalog.message}</Text>;
  if (matches.length === 0) return <Text dimColor>No matching files</Text>;
  return (
    <Box flexDirection="column">
      {matches.map((match, index) => (
        <Text key={match.path}>
          {index === selectedIndex ? "❯ " : "  "}
          {renderMatchedPath(match)}
        </Text>
      ))}
    </Box>
  );
}

function renderMatchedPath(match: FileMentionMatch) {
  const matchedIndices = new Set(match.indices);
  return (
    <Text>
      {[...match.path].map((char, index) => (
        <Text key={`${index}:${char}`} bold={matchedIndices.has(index)}>
          {char}
        </Text>
      ))}
    </Text>
  );
}

function phaseLabel(phase: PromptInputPhase): string {
  switch (phase.kind) {
    case "idle":
      return "ready";
    case "attaching":
      return "attaching image…";
    case "restoring_history":
      return "restoring history…";
    case "admitting":
      return "admitting turn…";
    case "maintenance_offer":
      return phase.operationId === undefined
        ? "maintenance choice"
        : `running ${maintenanceLabel(phase.action)}…`;
  }
}

function maintenanceAction(input: string): PromptMaintenanceAction | undefined {
  if (input === "c") return "compact";
  if (input === "r") return "retire";
  if (input === "n") return "new_session";
  return undefined;
}

function maintenanceLabel(action: PromptMaintenanceAction | undefined): string {
  if (action === "compact") return "compact";
  if (action === "retire") return "compact retire";
  if (action === "new_session") return "new session";
  return "maintenance";
}

function normalizeLineBreaks(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function fileMentionReplacement(
  value: string,
  mentionEnd: number,
  filePath: string,
): string {
  const suffixStart = [...value][mentionEnd];
  return suffixStart !== undefined && suffixStart !== "\n" && /\s/u.test(suffixStart)
    ? filePath
    : `${filePath} `;
}

function contextColor(
  pressure: ContextUsageSnapshot["pressure"],
): "yellow" | "red" | undefined {
  return pressure === "blocked"
    ? "red"
    : pressure === "triggered"
      ? "yellow"
      : undefined;
}

function formatWorkspacePath(workspaceRoot: string): string {
  const home = os.homedir();
  const relative = path.relative(home, workspaceRoot);
  if (relative === "") return home;
  const isInsideHome =
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
  return isInsideHome ? `~${path.sep}${relative}` : workspaceRoot;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
