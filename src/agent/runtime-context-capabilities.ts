import { CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION } from "../context/recall-retirement-contract";
import type { ToolRegistry } from "../tools/registry";

/** Structural runtime prerequisites, not model qualification or description hashes. */
export function assertContextMaintenanceCapabilities(
  registry: Pick<ToolRegistry, "get">,
  recallContractVersion: string,
): void {
  for (const name of ["RecallSearch", "RecallGet"]) {
    if (registry.get(name) === undefined) {
      throw new Error(`Context maintenance requires an executable ${name} tool.`);
    }
  }
  if (recallContractVersion !== CURRENT_RECALL_RETIREMENT_CONTRACT_VERSION) {
    throw new Error(
      "Context maintenance requires the current Recall retirement contract.",
    );
  }
}
