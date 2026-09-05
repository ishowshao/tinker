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
    "9c3dfef7e922f40470f284e87893e3d2494b46aad65faa91a0a6bd4541b357d5",
  negativeReportSha256:
    "d7ea94174a84acbd54bf6cdae7da1a1fa25fe66b23c7020a2ff119b6e8cc8863",
  resolvedModel: "deepseek-v4-flash",
  recallContractVersion: CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION,
  recallContractSha256:
    "3b6d1a452efea1db5920eb13542571b038667ef4f635551bea375bda6562a39f",
  recallToolDefinitionSha256:
    "0af1dcea5ccbb0619c36d2bf0df1e183a0213b1a5b8b2a6181c38a0fc79705eb",
  metrics: Object.freeze({
    fullHistoryTaskSuccessRate: 0.9667,
    swapOnlyTaskSuccessRate: 1,
    recallOnlyTaskSuccessRate: 1,
    recallOnlyActiveRecallRate: 1,
    recallOnlySearchGetSuccessRate: 0.1333,
    minimumCounterfactualGroupTaskSuccessRate: 1,
    invalidRecallCallsPerRecallOnlyTrial: 0,
    negativeUnnecessaryRecallRate: 0,
    recallOnlyTokenRatioToFullHistory: 0.2813,
    recallOnlyLatencyRatioToFullHistory: 0.8764,
  }),
  // Session-selection holdout missed the frozen Search -> Get gate (0.1333 < 0.3).
  // Preserve this measured failure separately from the explicit continuity decision below.
  passed: false,
} as const);

// Explicit user decision including the reviewed description-only cleanup: preserve
// automation for this exact surface. The original evaluation remains unchanged;
// this is not a qualification pass and must not carry to future surface changes.
export const RECALL_SESSION_SELECTION_CONTINUITY = Object.freeze({
  decisionId: "recall-session-selection-description-continuity-v2",
  recallContractSha256:
    "3b6d1a452efea1db5920eb13542571b038667ef4f635551bea375bda6562a39f",
  evaluatedRecallToolDefinitionSha256:
    "0af1dcea5ccbb0619c36d2bf0df1e183a0213b1a5b8b2a6181c38a0fc79705eb",
  recallToolDefinitionSha256:
    "072ffe5ee810bcd06ae681eb3749400ab6e9219c3d762e3e0e0ad5cc9573d53e",
  positiveReportSha256:
    "9c3dfef7e922f40470f284e87893e3d2494b46aad65faa91a0a6bd4541b357d5",
  negativeReportSha256:
    "d7ea94174a84acbd54bf6cdae7da1a1fa25fe66b23c7020a2ff119b6e8cc8863",
});

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
    | "explicit_continuity"
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
  const continuity = RECALL_SESSION_SELECTION_CONTINUITY;
  const explicitContinuity =
    evidence === I4_ACTIVE_RECALL_QUALIFICATION &&
    !evidence.passed &&
    evidence.recallContractSha256 === continuity.recallContractSha256 &&
    evidence.recallToolDefinitionSha256 ===
      continuity.evaluatedRecallToolDefinitionSha256 &&
    I4_ACTIVE_RECALL_QUALIFICATION.positiveReportSha256 ===
      continuity.positiveReportSha256 &&
    I4_ACTIVE_RECALL_QUALIFICATION.negativeReportSha256 ===
      continuity.negativeReportSha256;
  const expectedToolHash = explicitContinuity
    ? continuity.recallToolDefinitionSha256
    : evidence.recallToolDefinitionSha256;
  if (
    recallTools.length !== 2 ||
    toolDefinitionsHash(recallTools) !== expectedToolHash ||
    toolDefinitionsHash(RECALL_TOOL_DEFINITIONS) !== expectedToolHash
  ) {
    return disabled("recall_tool_mismatch");
  }
  if (explicitContinuity) {
    return Object.freeze({
      automaticSwapOnly: true,
      automaticPrefixRetirement: true,
      reason: "explicit_continuity",
      qualificationId: continuity.decisionId,
    });
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
