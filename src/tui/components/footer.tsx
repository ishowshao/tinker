import { StatusMessage } from "@inkjs/ui";
import { Text } from "ink";

export type FooterProps = {
  status: "idle" | "running" | "cancelling" | "cancelled" | "done" | "failed";
  workedForMs?: number;
  elapsedMs?: number;
};

export function Footer(props: FooterProps) {
  if (props.status === "done") {
    if (props.workedForMs === undefined) {
      throw new Error("Done footer requires workedForMs");
    }

    return (
      <StatusMessage variant="success">
        Worked for {formatDuration(props.workedForMs)}
      </StatusMessage>
    );
  }

  if (props.status === "failed") {
    return <StatusMessage variant="error">failed</StatusMessage>;
  }

  if (props.status === "running") {
    if (props.elapsedMs === undefined) {
      return <Text color="yellow">• Running</Text>;
    }

    return <Text color="yellow">{`• Running ${formatDuration(props.elapsedMs)}`}</Text>;
  }

  if (props.status === "cancelling") {
    return <StatusMessage variant="info">cancelling</StatusMessage>;
  }

  if (props.status === "cancelled") {
    return <StatusMessage variant="info">cancelled</StatusMessage>;
  }

  return <StatusMessage variant="info">idle</StatusMessage>;
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error(`Invalid duration: ${durationMs}`);
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}
