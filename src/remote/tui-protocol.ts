import type { ClientModelCatalog } from "../client/model-catalog";
import type { ReasoningEffortSnapshot } from "../model/reasoning-effort";
import type { ProviderRetrySnapshot } from "../agent/runtime-provider-retry";
import type { AskUserSnapshot } from "../agent/runtime-session";
import type { PromptSchedulerSnapshot } from "../agent/runtime-session-contracts";
import type { TuiTimelineLog } from "../tui/tui-projection-store";
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
  profileName?: string;
  modelCatalog?: ClientModelCatalog;
  reasoningEffort?: ReasoningEffortSnapshot;
  supportsImageInput: boolean;
  cursor: RemoteCursor;
  activity: RemoteActivity;
  history: TuiProjectionState;
  timeline: TuiTimelineLog;
  promptScheduler: PromptSchedulerSnapshot;
  bashGuard: BashGuardSnapshot & { interactionId?: string };
  askUser: AskUserSnapshot & { interactionId?: string };
  providerRetry: ProviderRetrySnapshot;
  skills: RuntimeSkillsSnapshot;
  mcp: McpInventorySnapshot;
};
