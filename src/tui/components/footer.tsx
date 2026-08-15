import { Spinner, StatusMessage } from "@inkjs/ui";

export type FooterProps = {
  status: "idle" | "running" | "cancelling" | "cancelled" | "done" | "failed";
  workedForMs?: number;
  yolo?: boolean;
  pendingFollowUps?: number;
};

export function Footer(props: FooterProps) {
  const suffix = props.yolo ? " · yolo" : "";
  if (props.status === "done") {
    if (props.workedForMs === undefined) {
      throw new Error("Done footer requires workedForMs");
    }

    return (
      <StatusMessage variant="success">
        Worked for {formatDuration(props.workedForMs)}
        {suffix}
      </StatusMessage>
    );
  }

  if (props.status === "failed") {
    return <StatusMessage variant="error">failed{suffix}</StatusMessage>;
  }

  if (props.status === "running") {
    const queued =
      props.pendingFollowUps === undefined || props.pendingFollowUps === 0
        ? ""
        : ` · ${props.pendingFollowUps} follow-up${props.pendingFollowUps === 1 ? "" : "s"} queued`;
    return <Spinner label={`Running${queued}${suffix}`} />;
  }

  if (props.status === "cancelling") {
    return <StatusMessage variant="info">cancelling{suffix}</StatusMessage>;
  }

  if (props.status === "cancelled") {
    return <StatusMessage variant="info">cancelled{suffix}</StatusMessage>;
  }

  return <StatusMessage variant="info">idle{suffix}</StatusMessage>;
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
