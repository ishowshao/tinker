import { runLongSessionBenchmark } from "./bench-long-session-memory";
import { runRecallBenchmark } from "./bench-recall";

const longSession = await runLongSessionBenchmark(12);
const finalRetirement = longSession.retirement.results.at(-1);
if (finalRetirement === undefined) {
  throw new Error("I3 long-session benchmark committed no prefix retirement.");
}
const compactionTimingVerified = longSession.compaction.results.every(
  (result) =>
    result.status === "compacted" &&
    [
      result.planningDurationMs,
      result.validationDurationMs,
      result.transactionDurationMs,
      result.activationDurationMs,
      result.durationMs,
    ].every((duration) => Number.isFinite(duration) && duration >= 0),
);
const retirementTimingVerified = longSession.retirement.results.every((result) =>
  [
    result.planningDurationMs,
    result.validationDurationMs,
    result.transactionDurationMs,
    result.activationDurationMs,
    result.durationMs,
  ].every((duration) => Number.isFinite(duration) && duration >= 0),
);
if (
  !longSession.resumeVerified ||
  !longSession.cancelledTurnVerified ||
  !longSession.recallVerified ||
  !longSession.shadow.forcedVerified ||
  !longSession.shadow.recallVerified ||
  longSession.compaction.count < 1 ||
  !compactionTimingVerified ||
  longSession.compaction.databaseAndWalBytes.samples.length !==
    longSession.compaction.count ||
  !longSession.compaction.providerRequestCountUnchanged ||
  longSession.compaction.activeRevisionNumber < 2 ||
  longSession.retirement.count !== 2 ||
  !retirementTimingVerified ||
  longSession.retirement.databaseAndWalBytes.samples.length !==
    longSession.retirement.count ||
  !longSession.retirement.providerRequestCountUnchanged ||
  !longSession.retirement.retiredPayloadVerified ||
  finalRetirement.keepFromOrdinal <= 1 ||
  longSession.database.schemaVersion !== 9 ||
  longSession.database.revisionKind !== "prefix_retirement" ||
  longSession.database.revisionNumber !== finalRetirement.revisionNumber ||
  longSession.shadow.selectedCandidateCount < 1 ||
  longSession.shadow.rawTokensAfter >= longSession.shadow.rawTokensBefore ||
  longSession.database.turnCount !== 14
) {
  throw new Error("I3 long-session benchmark smoke did not satisfy its contract.");
}

const recall = await runRecallBenchmark(200, 3);
if (
  recall.messageCount !== 200 ||
  recall.databaseBytes.increment <= 0 ||
  recall.timingMs.trigramSearch.p95 < 0
) {
  throw new Error("G0 Recall benchmark smoke did not satisfy its contract.");
}

console.log(
  [
    "I3 benchmark smoke passed.",
    `long-session turns=${longSession.database.turnCount}`,
    `messages=${longSession.database.messageCount}`,
    `shadow selected=${longSession.shadow.selectedCandidateCount}`,
    `revision=${finalRetirement.revisionNumber}`,
    `keep=${finalRetirement.keepFromOrdinal}`,
    `retirements=${longSession.retirement.count}`,
    `retired turns=${longSession.retirement.results.reduce((total, result) => total + result.retiredTurnCount, 0)}`,
    `overrides=${finalRetirement.activeOverrideCount}`,
    `recall messages=${recall.messageCount}`,
  ].join(" "),
);
