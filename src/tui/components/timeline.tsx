import { Box, Text } from "ink";
import { Fragment } from "react";
import type { AgentEvent } from "../../events/types";
import type { TimelineItem } from "../event-store";

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
    if (event.type === "model.step.started") {
      return [
        {
          id: `${index}-model-started`,
          text: `model step ${event.step} started`,
          status: "running",
        },
      ];
    }

    if (event.type === "model.step.finished") {
      return [
        {
          id: `${index}-model-finished`,
          text: `model step ${event.step} finished`,
          status: "ok",
        },
      ];
    }

    if (event.type === "tool.started") {
      return [
        {
          id: `${index}-tool-started`,
          text: `${event.call.name} ${toolPath(event.call.args) ?? ""}`.trim(),
          status: "running",
        },
      ];
    }

    if (event.type === "tool.finished") {
      return [
        {
          id: `${index}-tool-finished`,
          text: `${event.call.name} ${toolPath(event.call.args) ?? ""}`.trim(),
          status: event.ok ? "ok" : "failed",
        },
      ];
    }

    if (event.type === "run.finished") {
      const text = finalText(event.result);
      return [
        {
          id: `${index}-run-finished`,
          text: text === undefined || text.trim() === "" ? "run finished" : text,
          label: text === undefined || text.trim() === "" ? undefined : "assistant",
          status: text === undefined || text.trim() === "" ? "ok" : "text",
        },
      ];
    }

    if (event.type === "run.failed") {
      return [
        {
          id: `${index}-run-failed`,
          label: "error",
          text: event.error,
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
    "ok" in result &&
    result.ok === true &&
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
    return (
      <Fragment key={item.id}>
        <Text color="gray">- {item.label}</Text>
        <Text color={colorForStatus(item.status)}>{formatTimelineItem(item)}</Text>
      </Fragment>
    );
  }

  return (
    <Text key={item.id} color={colorForStatus(item.status)}>
      {formatTimelineItem(item)}
    </Text>
  );
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

  return "gray";
}

function symbolForStatus(status: TimelineItem["status"]): string {
  if (status === "ok") {
    return "ok";
  }

  if (status === "failed") {
    return "fail";
  }

  if (status === "running") {
    return "...";
  }

  return "-";
}
