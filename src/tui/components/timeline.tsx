import { Box, Text } from "ink";
import { Fragment } from "react";
import type { AgentEvent } from "../../events/types";
import type { TimelineItem } from "../event-store";
import { AssistantMarkdown } from "./assistant-markdown";
import { BashResultView } from "./bash-result-view";
import { DiffView } from "./diff-view";

export type TimelineProps = {
  events?: AgentEvent[];
  items?: TimelineItem[];
};

export function Timeline(props: TimelineProps) {
  const items = props.items ?? timelineItemsFromEvents(props.events ?? []);

  return (
    <Box flexDirection="column">
      <Text bold>Timeline</Text>
      {items.length === 0 ? (
        <Text color="gray">idle</Text>
      ) : (
        items.map((item) => renderTimelineItem(item))
      )}
    </Box>
  );
}

function timelineItemsFromEvents(events: AgentEvent[]): TimelineItem[] {
  return events.flatMap((event, index): TimelineItem[] => {
    if (event.type === "model.request.started") {
      return [
        {
          id: `${index}-model-started`,
          text: `model iteration ${event.iterationNumber} started`,
          status: "running",
        },
      ];
    }

    if (event.type === "model.request.finished") {
      return [
        {
          id: `${index}-model-finished`,
          text: `model iteration ${event.iterationNumber} finished`,
          status: "ok",
        },
      ];
    }

    if (event.type === "tool.started") {
      return [
        {
          id: `${index}-tool-started`,
          text: `${event.data.call.name} ${toolPath(event.data.call.args) ?? ""}`.trim(),
          status: "running",
        },
      ];
    }

    if (event.type === "tool.finished") {
      return [
        {
          id: `${index}-tool-finished`,
          text: `${event.data.call.name} ${toolPath(event.data.call.args) ?? ""}`.trim(),
          status: event.data.ok ? "ok" : "failed",
        },
      ];
    }

    if (event.type === "turn.finished") {
      const text = finalText(event.data.result);
      return [
        {
          id: `${index}-turn-finished`,
          text: text === undefined || text.trim() === "" ? "turn finished" : text,
          label: text === undefined || text.trim() === "" ? undefined : "assistant",
          status: text === undefined || text.trim() === "" ? "ok" : "text",
        },
      ];
    }

    if (event.type === "turn.cancelled") {
      return [
        {
          id: `${index}-turn-cancelled`,
          text: "turn cancelled",
          status: "cancelled",
        },
      ];
    }

    if (event.type === "turn.failed") {
      return [
        {
          id: `${index}-turn-failed`,
          label: "error",
          text: event.data.error,
          status: "failed",
        },
      ];
    }

    return [];
  });
}

function finalText(result: unknown): string | undefined {
  if (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    result.status === "completed" &&
    "finalText" in result &&
    typeof result.finalText === "string"
  ) {
    return result.finalText;
  }

  return undefined;
}

function toolPath(args: unknown): string | undefined {
  if (
    typeof args === "object" &&
    args !== null &&
    !Array.isArray(args) &&
    "file_path" in args &&
    typeof args.file_path === "string"
  ) {
    return args.file_path;
  }

  return undefined;
}

function renderTimelineItem(item: TimelineItem) {
  if (item.label !== undefined) {
    if (item.label === "assistant") {
      return (
        <Fragment key={item.id}>
          <Text color="gray">- {item.label}</Text>
          <AssistantMarkdown text={item.text} />
        </Fragment>
      );
    }

    return (
      <Fragment key={item.id}>
        <Text color="gray">- {item.label}</Text>
        <Text color={colorForStatus(item.status)}>{formatTimelineItem(item)}</Text>
        {renderItemBash(item)}
        {renderItemDiff(item)}
      </Fragment>
    );
  }

  return (
    <Fragment key={item.id}>
      <Text color={colorForStatus(item.status)}>{formatTimelineItem(item)}</Text>
      {renderItemBash(item)}
      {renderItemDiff(item)}
    </Fragment>
  );
}

function renderItemDiff(item: TimelineItem) {
  if (item.diff === undefined || item.diff.length === 0) {
    return null;
  }

  return <DiffView hunks={item.diff} truncated={item.diffTruncated} />;
}

function renderItemBash(item: TimelineItem) {
  if (item.bash === undefined) {
    return null;
  }

  return <BashResultView detail={item.bash} />;
}

function formatTimelineItem(item: TimelineItem): string {
  if (item.status === "text") {
    return item.text;
  }

  return `${symbolForStatus(item.status)} ${item.text}`;
}

function colorForStatus(status: TimelineItem["status"]): string {
  if (status === "text") {
    return "white";
  }

  if (status === "ok") {
    return "green";
  }

  if (status === "failed") {
    return "red";
  }

  if (status === "running") {
    return "yellow";
  }

  if (status === "cancelled") {
    return "gray";
  }

  return "gray";
}

function symbolForStatus(status: TimelineItem["status"]): string {
  if (status === "ok") {
    return "✔";
  }

  if (status === "failed") {
    return "✘";
  }

  if (status === "running") {
    return "…";
  }

  if (status === "cancelled") {
    return "⊘";
  }

  return "-";
}
