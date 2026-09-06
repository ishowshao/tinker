import { expect, test } from "bun:test";
import {
  onlyNonEmptySession,
  quitTui,
  submitPrompt,
  waitForInitialFrame,
  withSessionDatabase,
} from "./helpers/pty-product-test-support";
import { withPtyTui } from "./helpers/pty-tui-harness";

test(
  "PTY: provider retry selection repeats in one iteration and completes without an extra prompt",
  async () => {
    await withPtyTui(
      { fakeModel: "pty-provider-retry", rows: 40, columns: 120 },
      async (harness) => {
        await waitForInitialFrame(harness);
        await submitPrompt(harness, "PTY_RETRY");
        await harness.waitForScreen("Automatic retries exhausted.");
        expect(harness.screenText()).toContain("Retry again");
        expect(harness.screenText()).toContain("End this turn");
        expect(harness.screenText()).toContain("Waiting for your selection");
        expect(harness.screenText()).not.toContain("DRAFT_ONLY");
        const mark = harness.markTranscript();
        await harness.press("enter");
        await harness.waitForTranscript("Attempt 4", { since: mark });
        await harness.waitForScreen("Automatic retries exhausted.");
        await harness.press("enter");
        await harness.waitForScreen("PTY_RETRY_DONE");
        await quitTui(harness);
        const session = await onlyNonEmptySession(
          harness.workspaceRoot,
          harness.homeRoot,
        );
        await withSessionDatabase(
          harness.workspaceRoot,
          harness.homeRoot,
          session,
          (database) => {
            expect(
              database.query("SELECT turn_number, status FROM turns").all(),
            ).toEqual([{ turn_number: 1, status: "completed" }]);
            expect(
              database.query("SELECT iteration_number, outcome FROM iterations").all(),
            ).toEqual([{ iteration_number: 1, outcome: "completed" }]);
            expect(
              database
                .query(
                  "SELECT role, content FROM messages WHERE role <> 'system' ORDER BY ordinal",
                )
                .all(),
            ).toEqual([
              { role: "user", content: "PTY_RETRY" },
              { role: "assistant", content: "PTY_RETRY_DONE" },
            ]);
          },
        );
      },
    );
  },
  { timeout: 25_000 },
);

for (const decision of ["selection", "escape"] as const) {
  test(
    `PTY: ending provider retries with ${decision} records failure and accepts another prompt`,
    async () => {
      await withPtyTui(
        { fakeModel: "pty-provider-retry", rows: 35, columns: 120 },
        async (harness) => {
          await waitForInitialFrame(harness);
          await submitPrompt(harness, "PTY_RETRY");
          await harness.waitForScreen("Automatic retries exhausted.");
          if (decision === "selection") {
            await harness.press("down");
            await harness.press("enter");
          } else await harness.press("escape");
          await harness.waitForScreen("Provider returned reasoning");
          expect(harness.screenText()).not.toContain("Automatic retries exhausted.");
          await submitPrompt(harness, "PTY_RETRY_NEXT");
          await harness.waitForScreen("PTY_RETRY_NEXT_DONE");
          await quitTui(harness);
          const session = await onlyNonEmptySession(
            harness.workspaceRoot,
            harness.homeRoot,
          );
          await withSessionDatabase(
            harness.workspaceRoot,
            harness.homeRoot,
            session,
            (database) => {
              expect(
                database.query("SELECT status FROM turns ORDER BY turn_number").all(),
              ).toEqual([{ status: "failed" }, { status: "completed" }]);
            },
          );
        },
      );
    },
    { timeout: 25_000 },
  );
}

test(
  "PTY: exiting while a provider retry question is pending settles the turn",
  async () => {
    await withPtyTui(
      { fakeModel: "pty-provider-retry", rows: 35, columns: 120 },
      async (harness) => {
        await waitForInitialFrame(harness);
        await submitPrompt(harness, "PTY_RETRY");
        await harness.waitForScreen("Automatic retries exhausted.");
        await harness.type("\u0003");
        expect(await harness.waitForExit(3_000)).toEqual({ code: 0, signal: null });
        const session = await onlyNonEmptySession(
          harness.workspaceRoot,
          harness.homeRoot,
        );
        await withSessionDatabase(
          harness.workspaceRoot,
          harness.homeRoot,
          session,
          (database) => {
            expect(database.query("SELECT status FROM turns").all()).toEqual([
              { status: "cancelled" },
            ]);
          },
        );
      },
    );
  },
  { timeout: 20_000 },
);
