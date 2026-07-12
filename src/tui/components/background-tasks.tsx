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
        <Box key={task.taskId} flexDirection="column">
          <Text color={colorForStatus(task.status)}>
            {symbolForStatus(task.status)} {task.status} {taskDescription(task)}
            {taskResult(task) === undefined ? "" : ` ${taskResult(task)}`}
          </Text>
          <Text dimColor>{taskTiming(task)}</Text>
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
  if (task.signal !== undefined) {
    return `signal=${task.signal}`;
  }

  if (task.exitCode !== undefined) {
    return `exit=${task.exitCode}`;
  }

  return task.error;
}

function taskTiming(task: ShellTaskSnapshot): string {
  const timing = [`id=${task.taskId}`, `started=${task.startedAt}`];
  if (task.endedAt === undefined) {
    return timing.join(" · ");
  }

  timing.push(`ended=${task.endedAt}`);
  return timing.join(" · ");
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
