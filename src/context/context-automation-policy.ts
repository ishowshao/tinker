import { stableJsonStringify, sha256 } from "../model/model-request-preflight";
import { RECALL_TOOL_DEFINITIONS } from "../tools/recall";
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
    "e827e5e94171328bb2dd7fcaeff91881f04bdfc78361a45e2548da323229b02a",
  negativeReportSha256:
    "ed379843aee0f193f398a4dff9a18ed338f0edab2cbaf9b628d0dfc402d925a4",
  resolvedModel: "deepseek-v4-flash",
  recallContractVersion: CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION,
  recallContractSha256:
    "3b6d1a452efea1db5920eb13542571b038667ef4f635551bea375bda6562a39f",
  recallToolDefinitionSha256:
    "e63ada7cdf9591d1e933cf5e190ea30586e02bbf73aeb5e648db449d75aae009",
  metrics: Object.freeze({
    fullHistoryTaskSuccessRate: 0.9667,
    swapOnlyTaskSuccessRate: 0.9667,
    recallOnlyTaskSuccessRate: 1,
    recallOnlyActiveRecallRate: 1,
    recallOnlySearchGetSuccessRate: 0.3333,
    minimumCounterfactualGroupTaskSuccessRate: 1,
    invalidRecallCallsPerRecallOnlyTrial: 0,
    negativeUnnecessaryRecallRate: 0,
    recallOnlyTokenRatioToFullHistory: 1.3739,
    recallOnlyLatencyRatioToFullHistory: 1.207,
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
  const recallTools = input.surface.toolDefinitions.filter(
    (definition) =>
      definition.name === "RecallSearch" || definition.name === "RecallGet",
  );
  if (
    recallTools.length !== 2 ||
    toolDefinitionsHash(recallTools) !== evidence.recallToolDefinitionSha256 ||
    toolDefinitionsHash(RECALL_TOOL_DEFINITIONS) !== evidence.recallToolDefinitionSha256
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

function toolDefinitionsHash(definitions: readonly ToolDefinition[]): string {
  return sha256(stableJsonStringify(definitions));
}
