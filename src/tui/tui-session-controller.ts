import type { SessionClient, WorkspaceClient } from "../client/session-client";
import type { TuiProjectionStore } from "./tui-projection-store";

/** Read-only presentation surface; the client adapter owns event ingestion. */
export type TuiSessionView = Pick<
  TuiProjectionStore,
  "getSnapshot" | "getLogSnapshot" | "subscribe"
>;
export type TuiSessionBinding = SessionClient<TuiSessionView>;
export type TuiSessionController = WorkspaceClient<TuiSessionView>;
