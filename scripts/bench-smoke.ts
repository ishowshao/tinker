import { runLongSessionBenchmark } from "./bench-long-session-memory";
import { runRecallBenchmark } from "./bench-recall";

const longSession = await runLongSessionBenchmark(12);
if (
  !longSession.resumeVerified ||
  !longSession.cancelledTurnVerified ||
  !longSession.recallVerified ||
  !longSession.shadow.forcedVerified ||
  !longSession.shadow.recallVerified ||
  longSession.shadow.selectedCandidateCount < 1 ||
  longSession.shadow.rawTokensAfter >= longSession.shadow.rawTokensBefore ||
  longSession.database.turnCount !== 14
) {
  throw new Error("G0 long-session benchmark smoke did not satisfy its contract.");
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
    "G0 benchmark smoke passed.",
    `long-session turns=${longSession.database.turnCount}`,
    `messages=${longSession.database.messageCount}`,
    `shadow selected=${longSession.shadow.selectedCandidateCount}`,
    `recall messages=${recall.messageCount}`,
  ].join(" "),
);
