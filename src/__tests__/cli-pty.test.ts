import { expect, test } from "bun:test";
import { withPtyTui } from "./helpers/pty-tui-harness";

test(
  "PTY-001: exits the complete TUI process after idle /quit",
  async () => {
    await withPtyTui({ fakeModel: "pty-quit" }, async (harness) => {
      await harness.waitForScreen("Tinker", {
        timeoutMs: 10_000,
        message: "initial Tinker frame",
      });

      const beforeInput = harness.markTranscript();
      await harness.type("/quit");
      await harness.waitForTranscript("/quit", {
        since: beforeInput,
        timeoutMs: 2_000,
        message: "new /quit input frame",
      });
      await harness.waitForScreen("Exit the TUI", {
        timeoutMs: 2_000,
        message: "/quit command suggestion",
      });
      expect(harness.transcriptSince(beforeInput)).toContain("/quit");

      await harness.press("enter");
      const exit = await harness.waitForExit(2_000);
      if (exit === undefined) {
        throw new Error(
          harness.diagnosticText("Tinker and PTY wrapper exit within 2000ms"),
        );
      }
      expect(exit).toEqual({ code: 0, signal: null });
      expect(harness.wrapperExit()).toEqual({ code: 0, signal: null });
    });
  },
  { timeout: 20_000 },
);
