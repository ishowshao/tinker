import { Box, Text } from "ink";
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
        items.map((item) => (
          <Text key={item.id} color={colorForStatus(item.status)}>
            {symbolForStatus(item.status)} {item.text}
          </Text>
        ))
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
      return [
        {
          id: `${index}-run-finished`,
          text: "run finished",
          status: "ok",
        },
      ];
    }

    if (event.type === "run.failed") {
      return [
        {
          id: `${index}-run-failed`,
          text: event.error,
          status: "failed",
        },
      ];
    }

    return [];
  });
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

function colorForStatus(status: TimelineItem["status"]): string {
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
