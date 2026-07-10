import { StatusMessage } from "@inkjs/ui";

export type FooterProps = {
  status: "idle" | "running" | "cancelling" | "cancelled" | "done" | "failed";
};

export function Footer(props: FooterProps) {
  if (props.status === "done") {
    return <StatusMessage variant="success">done</StatusMessage>;
  }

  if (props.status === "failed") {
    return <StatusMessage variant="error">failed</StatusMessage>;
  }

  if (props.status === "running") {
    return <StatusMessage variant="info">running</StatusMessage>;
  }

  if (props.status === "cancelling") {
    return <StatusMessage variant="info">cancelling</StatusMessage>;
  }

  if (props.status === "cancelled") {
    return <StatusMessage variant="info">cancelled</StatusMessage>;
  }

  return <StatusMessage variant="info">idle</StatusMessage>;
}
