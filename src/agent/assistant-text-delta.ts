import type { IterationIdentity } from "./types";

export type AssistantTextDeltaUpdate = IterationIdentity & {
  attemptNumber: number;
  content: string;
};

export interface AssistantTextDeltaSink {
  updateAssistantTextDelta(update: AssistantTextDeltaUpdate): void;
}
