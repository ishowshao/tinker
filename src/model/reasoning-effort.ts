export type ReasoningEffortConfig = {
  readonly supportedEfforts: readonly string[];
  readonly defaultEffort: string;
};

export type ReasoningEffortSnapshot = {
  readonly supportedEfforts: readonly string[];
  readonly defaultEffort: string;
  readonly effort: string;
  readonly source: "profile_default" | "session_override";
};

export type ReasoningEffortController = {
  snapshot(): ReasoningEffortSnapshot;
  set(effort: string): ReasoningEffortSnapshot;
  reset(): ReasoningEffortSnapshot;
};

export class RuntimeReasoningEffort implements ReasoningEffortController {
  private effort: string;
  private source: ReasoningEffortSnapshot["source"] = "profile_default";
  private readonly supportedEfforts: readonly string[];

  constructor(private readonly config: ReasoningEffortConfig) {
    this.supportedEfforts = Object.freeze([...config.supportedEfforts]);
    this.effort = config.defaultEffort;
  }

  snapshot(): ReasoningEffortSnapshot {
    return Object.freeze({
      supportedEfforts: this.supportedEfforts,
      defaultEffort: this.config.defaultEffort,
      effort: this.effort,
      source: this.source,
    });
  }

  set(effort: string): ReasoningEffortSnapshot {
    if (!this.supportedEfforts.includes(effort)) {
      throw new Error(
        `Unsupported reasoning effort ${JSON.stringify(effort)}. Available efforts: ${this.supportedEfforts.join(", ")}.`,
      );
    }
    this.effort = effort;
    this.source = "session_override";
    return this.snapshot();
  }

  reset(): ReasoningEffortSnapshot {
    this.effort = this.config.defaultEffort;
    this.source = "profile_default";
    return this.snapshot();
  }
}

export function createReasoningEffortController(
  config: ReasoningEffortConfig | undefined,
): ReasoningEffortController | undefined {
  return config === undefined ? undefined : new RuntimeReasoningEffort(config);
}
