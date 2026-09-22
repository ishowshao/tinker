import type { SessionClient, WorkspaceClient } from "../client/session-client";
import type { TuiProjectionStore } from "./tui-projection-store";

export type TuiServiceStatus = { connection: string; activity: string; error?: string };

/** Read-only presentation surface; the client adapter owns event ingestion. */
export type TuiSessionView = Pick<
  TuiProjectionStore,
  "getSnapshot" | "getLogSnapshot" | "subscribe"
> & { getServiceStatus?: () => TuiServiceStatus };
export type TuiSessionBinding = SessionClient<TuiSessionView>;
export type TuiSessionController = WorkspaceClient<TuiSessionView>;
