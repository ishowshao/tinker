import type {
  BashGuardSnapshot,
  RuntimeSkillsSnapshot,
} from "../agent/runtime-session";
import type { McpInventorySnapshot } from "../mcp/mcp-manager";
import type { TuiProjectionState } from "../tui/event-store";
import type { RemoteActivity, RemoteCursor } from "./protocol";

/** Additive v1 read model for the full terminal renderer; no raw runtime events. */
export type RemoteTuiSnapshot = {
  version: 1;
  cursor: RemoteCursor;
  activity: RemoteActivity;
  history: TuiProjectionState;
  bashGuard: BashGuardSnapshot;
  skills: RuntimeSkillsSnapshot;
  mcp: McpInventorySnapshot;
};
