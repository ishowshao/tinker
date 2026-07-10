import { Box, Text } from "ink";
import type { ShellTaskSnapshot, ShellTaskStatus } from "../../tools/bash-task";

export type BackgroundTasksProps = {
  tasks: ShellTaskSnapshot[];
};

export function BackgroundTasks(props: BackgroundTasksProps) {
  if (props.tasks.length === 0) {
    return null;
  }

  const runningCount = props.tasks.filter(
    (task) => task.status === "running" || task.status === "stopping",
  ).length;

  return (
    <Box flexDirection="column">
      <Text bold>
        Background tasks · {runningCount} running / {props.tasks.length} total
      </Text>
      {props.tasks.map((task) => (
        <Box key={task.taskId} flexDirection="column" marginTop={1} paddingLeft={1}>
          <Text color={colorForStatus(task.status)}>
            {symbolForStatus(task.status)} {task.status}
          </Text>
          <Text dimColor>id={task.taskId}</Text>
          <Text wrap="truncate-end">{taskDescription(task)}</Text>
          <Text dimColor>started={task.startedAt}</Text>
          {taskResult(task) === undefined ? null : (
            <Text dimColor>{taskResult(task)}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}

function taskDescription(task: ShellTaskSnapshot): string {
  const description = task.description.trim();
  return description === "" ? task.command.replace(/\s+/g, " ").trim() : description;
}

function taskResult(task: ShellTaskSnapshot): string | undefined {
  if (task.endedAt === undefined) {
    return undefined;
  }

  const result =
    task.signal === undefined
      ? task.exitCode === undefined
        ? task.error
        : `exit=${task.exitCode}`
      : `signal=${task.signal}`;
  return `ended=${task.endedAt}${result === undefined ? "" : ` ${result}`}`;
}

function colorForStatus(status: ShellTaskStatus): string {
  if (status === "completed") {
    return "green";
  }

  if (status === "failed") {
    return "red";
  }

  if (status === "killed") {
    return "gray";
  }

  return "yellow";
}

function symbolForStatus(status: ShellTaskStatus): string {
  if (status === "completed") {
    return "✔";
  }

  if (status === "failed") {
    return "✘";
  }

  if (status === "killed") {
    return "■";
  }

  return "…";
}
