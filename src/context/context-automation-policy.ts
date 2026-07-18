import { stableJsonStringify, sha256 } from "../model/model-request-preflight";
import { RECALL_TOOL_DEFINITION } from "../tools/recall";
import type { ToolDefinition } from "../tools/types";
import type { StoredContextSurfaceV8 } from "./context-surface";
import {
  CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION,
  renderRecallRetirementContract,
} from "./recall-retirement-contract";

export const I4_ACTIVE_RECALL_QUALIFICATION = Object.freeze({
  qualificationId: "deepseek-v4-flash-floor-v1",
  evaluatedProfile: "deepseek-v4-flash",
  manifestVersion: "active-recall-manifest-v1",
  manifestSha256: "093679e221e02b71ba5acf54693faa7a299d05dd25f6faabbeb84645d4db4d2d",
  graderVersion: "active-recall-deterministic-grader-v1",
  fixtureVersion: "active-recall-long-session-fixture-v1",
  policyVersion: "active-recall-qualification-policy-v1",
  policySha256: "77ca611594d4e9b7b5a597a3a33e35fcaaffae284dc2ac9953ce9a63cce1c009",
  positiveReportSha256:
    "ef84dfee3fdefd7bbf1be2f1641bccc4a1aa06874b22172fecc03dfa2db840d6",
  negativeReportSha256:
    "c991980ae2824102174315c9b25c1e4affdbbd22aac320e1a254f2702ba3d1b4",
  resolvedModel: "deepseek-v4-flash",
  recallContractVersion: CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION,
  recallContractSha256:
    "c75108d351ed3223928ebeb52c7258a6f95033287a8e560fb5b2efff8e084c9b",
  recallToolDefinitionSha256:
    "60caf87f313ea35e74e278ab8b30337cc8af1cc83d82d957a73857a764f3e3d9",
  metrics: Object.freeze({
    fullHistoryTaskSuccessRate: 1,
    swapOnlyTaskSuccessRate: 1,
    recallOnlyTaskSuccessRate: 0.9667,
    recallOnlyActiveRecallRate: 0.9667,
    recallOnlySearchGetSuccessRate: 0.3,
    minimumCounterfactualGroupTaskSuccessRate: 0.8333,
    invalidRecallCallsPerRecallOnlyTrial: 0.0333,
    negativeUnnecessaryRecallRate: 0,
    recallOnlyTokenRatioToFullHistory: 1.1555,
    recallOnlyLatencyRatioToFullHistory: 1.365,
  }),
  passed: true,
} as const);

export const I4_SWAP_ONLY_QUALIFICATION_ID = "swap-only-engineering-v1";

export type ActiveRecallQualificationEvidence = {
  readonly qualificationId: string;
  readonly recallContractVersion: string;
  readonly recallContractSha256: string;
  readonly recallToolDefinitionSha256: string;
  readonly passed: boolean;
};

export type ContextAutomationDecision = {
  readonly automaticSwapOnly: boolean;
  readonly automaticPrefixRetirement: boolean;
  readonly reason:
    | "qualified"
    | "swap_only_qualified"
    | "qualification_pending"
    | "unprofiled_model"
    | "recall_contract_mismatch"
    | "recall_tool_mismatch";
  readonly qualificationId?: string;
};

export function selectContextAutomation(
  input: {
    readonly profileName?: string;
    readonly surface: StoredContextSurfaceV8;
  },
  evidence: ActiveRecallQualificationEvidence = I4_ACTIVE_RECALL_QUALIFICATION,
): ContextAutomationDecision {
  if (input.profileName === undefined) {
    return disabled("unprofiled_model");
  }
  if (
    input.surface.recallContractVersion !== evidence.recallContractVersion ||
    sha256(renderRecallRetirementContract()) !== evidence.recallContractSha256
  ) {
    return disabled("recall_contract_mismatch");
  }
  const recall = input.surface.toolDefinitions.find(
    (definition) => definition.name === "Recall",
  );
  if (
    recall === undefined ||
    toolDefinitionHash(recall) !== evidence.recallToolDefinitionSha256 ||
    toolDefinitionHash(RECALL_TOOL_DEFINITION) !== evidence.recallToolDefinitionSha256
  ) {
    return disabled("recall_tool_mismatch");
  }
  if (!evidence.passed) {
    return Object.freeze({
      automaticSwapOnly: true,
      automaticPrefixRetirement: false,
      reason: "swap_only_qualified",
      qualificationId: I4_SWAP_ONLY_QUALIFICATION_ID,
    });
  }
  return Object.freeze({
    automaticSwapOnly: true,
    automaticPrefixRetirement: true,
    reason: "qualified",
    qualificationId: evidence.qualificationId,
  });
}

function disabled(
  reason: Exclude<ContextAutomationDecision["reason"], "qualified">,
): ContextAutomationDecision {
  return Object.freeze({
    automaticSwapOnly: false,
    automaticPrefixRetirement: false,
    reason,
  });
}

function toolDefinitionHash(definition: ToolDefinition): string {
  return sha256(stableJsonStringify(definition));
}
