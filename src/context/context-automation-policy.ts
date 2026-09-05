/** Product defaults only. Evaluation results and model identities never select these flags.
 * Planners and session boundaries independently validate each operation before execution.
 */
export type ContextAutomationPolicy = {
  readonly policyId: string;
  readonly automaticSwap: boolean;
  readonly automaticPrefixRetirement: boolean;
};

export const DEFAULT_CONTEXT_AUTOMATION_POLICY: ContextAutomationPolicy = Object.freeze(
  {
    policyId: "context-automation-v1",
    automaticSwap: true,
    automaticPrefixRetirement: true,
  },
);
