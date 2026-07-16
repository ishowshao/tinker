import { runLongSessionBenchmark } from "./bench-long-session-memory";
import { runRecallBenchmark } from "./bench-recall";

const longSession = await runLongSessionBenchmark(3);
if (
  !longSession.resumeVerified ||
  !longSession.cancelledTurnVerified ||
  !longSession.recallVerified ||
  longSession.database.turnCount !== 5
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
    `recall messages=${recall.messageCount}`,
  ].join(" "),
);
