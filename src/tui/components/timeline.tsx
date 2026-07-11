import { Box, Text } from "ink";
import { Fragment } from "react";
import type { TimelineItem } from "../event-store";
import { AssistantMarkdown } from "./assistant-markdown";
import { BashResultView } from "./bash-result-view";
import { DiffView } from "./diff-view";

export type TimelineProps = {
  items: TimelineItem[];
};

export function Timeline(props: TimelineProps) {
  return (
    <Box flexDirection="column">
      <Text bold>Timeline</Text>
      {props.items.length === 0 ? (
        <Text color="gray">idle</Text>
      ) : (
        props.items.map((item) => renderTimelineItem(item))
      )}
    </Box>
  );
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
