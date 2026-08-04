import { Box, Text } from "ink";
import { Fragment } from "react";
import type { TimelineItem } from "../event-store";
import type { AssistantStreamSectionItem } from "../tui-projection-store";
import { AssistantMarkdown } from "./assistant-markdown";
import { BashResultView } from "./bash-result-view";
import { DiffView } from "./diff-view";
import { PlanView } from "./plan-view";

export type TimelineProps = {
  items: readonly TimelineItem[];
};

export function Timeline(props: TimelineProps) {
  return (
    <Box flexDirection="column">
      {props.items.map((item) => (
        <TimelineRow key={item.id} item={item} />
      ))}
    </Box>
  );
}

export function TimelineRow(props: { item: TimelineItem }) {
  const { item } = props;
  if (item.label !== undefined) {
    if (item.label === "assistant") {
      return (
        <Fragment>
          <Text color="gray">- {item.label}</Text>
          <AssistantMarkdown text={item.text} />
        </Fragment>
      );
    }

    return (
      <Fragment>
        <Text color="gray">- {item.label}</Text>
        {item.userPrompt === undefined ? (
          <Text color={colorForStatus(item.status)}>{formatTimelineItem(item)}</Text>
        ) : (
          renderUserPrompt(item.userPrompt)
        )}
        {renderItemBash(item)}
        {renderItemDiff(item)}
        {renderItemPlan(item)}
      </Fragment>
    );
  }

  return (
    <Fragment>
      <Text color={colorForStatus(item.status)}>{formatTimelineItem(item)}</Text>
      {renderItemBash(item)}
      {renderItemDiff(item)}
      {renderItemPlan(item)}
    </Fragment>
  );
}

export function AssistantStreamSectionRow(props: { item: AssistantStreamSectionItem }) {
  return (
    <Fragment>
      {props.item.showAssistantLabel ? <Text color="gray">- assistant</Text> : null}
      <AssistantMarkdown text={props.item.markdown} />
    </Fragment>
  );
}

function renderUserPrompt(prompt: NonNullable<TimelineItem["userPrompt"]>) {
  const chars = [...prompt.text];
  const fragments: React.ReactNode[] = [];
  let offset = 0;
  for (const image of prompt.images) {
    fragments.push(chars.slice(offset, image.range.start).join(""));
    fragments.push(
      <Text key={`${image.range.start}:${image.label}`} color="cyan" bold>
        {chars.slice(image.range.start, image.range.end).join("")}
        <Text dimColor> ({image.originalName})</Text>
      </Text>,
    );
    offset = image.range.end;
  }
  fragments.push(chars.slice(offset).join(""));
  if (prompt.omittedImageCount > 0) {
    fragments.push(
      <Text key="omitted-images" dimColor>
        {` [${prompt.omittedImageCount} image(s) omitted]`}
      </Text>,
    );
  }
  return <Text color="white">{fragments}</Text>;
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

function renderItemPlan(item: TimelineItem) {
  return item.plan === undefined ? null : <PlanView plan={item.plan} />;
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
