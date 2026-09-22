import { PromptHistory, type LoadedPromptHistoryRecord } from "../tui/prompt-history";
import type { PromptDraft } from "../tui/prompt-draft";

/** Draft navigation stays synchronous; persistence belongs to the service workspace. */
export class RemotePromptHistory extends PromptHistory {
  private pending: Promise<void> = Promise.resolve();
  constructor(
    records: LoadedPromptHistoryRecord[],
    private readonly persist: (prompt: string | PromptDraft) => Promise<void>,
  ) {
    super({ records });
  }
  override async append(prompt: string | PromptDraft): Promise<void> {
    await super.append(prompt);
    const next = this.pending.catch(() => undefined).then(() => this.persist(prompt));
    this.pending = next;
    await next;
  }
  async flush(): Promise<void> {
    await this.pending.catch(() => undefined);
  }
}
