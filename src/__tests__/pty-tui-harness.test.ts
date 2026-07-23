import { expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import {
  bracketedPasteSequence,
  mouseWheelSequence,
  normalizeScreenWhitespace,
  ptyKeySequence,
  startPtyTui,
  type PtyKey,
} from "./helpers/pty-tui-harness";
import { PtyTerminalScreen } from "./helpers/pty-terminal-screen";

test("projects the current Unicode VT screen instead of accumulated output", async () => {
  const screen = new PtyTerminalScreen(3, 16);
  try {
    await screen.write("stale frame\r\nstale line");
    await screen.write("\x1b[H\x1b[2J当前😀e\u0301");

    expect(screen.text()).toBe("当前😀e\u0301");

    await screen.resize(2, 10);
    await screen.write("\x1b[2J\x1b[H宽字符");
    expect(screen.text()).toBe("宽字符");
    expect(screen.rows).toBe(2);
    expect(screen.columns).toBe(10);
  } finally {
    screen.dispose();
  }
});

test("encodes semantic PTY input with terminal-standard byte sequences", () => {
  const keys: readonly PtyKey[] = [
    "enter",
    "escape",
    "tab",
    "up",
    "down",
    "left",
    "right",
    "home",
    "end",
    "page_up",
    "page_down",
    "ctrl_a",
    "ctrl_d",
    "ctrl_e",
    "ctrl_u",
  ];

  expect(keys.map(ptyKeySequence)).toEqual([
    "\r",
    "\x1b",
    "\t",
    "\x1b[A",
    "\x1b[B",
    "\x1b[D",
    "\x1b[C",
    "\x1b[H",
    "\x1b[F",
    "\x1b[5~",
    "\x1b[6~",
    "\x01",
    "\x04",
    "\x05",
    "\x15",
  ]);
  expect(bracketedPasteSequence("一\n二")).toBe("\x1b[200~一\n二\x1b[201~");
  expect(mouseWheelSequence("up", 3, 4)).toBe("\x1b[<64;3;4M");
  expect(mouseWheelSequence("down", 3, 4)).toBe("\x1b[<65;3;4M");
  expect(normalizeScreenWhitespace(" notice\n  wrapped ")).toBe("notice wrapped");
});

test(
  "uses host acknowledgements for resize and includes a complete timeout diagnostic",
  async () => {
    const harness = await startPtyTui({
      fakeModel: "pty-harness-control",
      rows: 18,
      columns: 72,
      workspaceFiles: { "fixture/note.txt": "workspace fixture\n" },
      homeFiles: { "fixture/home.txt": "home fixture\n" },
    });
    const workspaceRoot = harness.workspaceRoot;
    const homeRoot = harness.homeRoot;
    try {
      await harness.waitForScreen("Tinker", {
        timeoutMs: 10_000,
        message: "initial Tinker frame",
      });
      expect(await readFile(`${workspaceRoot}/fixture/note.txt`, "utf8")).toBe(
        "workspace fixture\n",
      );
      expect(await readFile(`${homeRoot}/fixture/home.txt`, "utf8")).toBe(
        "home fixture\n",
      );

      await harness.resize(20, 80);
      await harness.waitForScreen("Tinker");

      let timeoutError: Error | undefined;
      try {
        await harness.waitForScreen("PTY_NEVER_RENDERED", {
          timeoutMs: 50,
          message: "intentional missing marker",
        });
      } catch (error) {
        timeoutError = error as Error;
      }
      expect(timeoutError).toBeInstanceOf(Error);
      expect(timeoutError?.message).toContain(
        "expected condition: screen: intentional missing marker",
      );
      expect(timeoutError?.message).toContain("current screen:");
      expect(timeoutError?.message).toContain("last 8 KiB transcript:");
      expect(timeoutError?.message).toContain("pty-host stderr:");
      expect(timeoutError?.message).toContain("wrapper exit state: <running>");
      expect(timeoutError?.message).toContain("child exit state: <running>");
      expect(timeoutError?.message).toContain("rows x columns: 20 x 80");
      expect(timeoutError?.message).toContain(`workspaceRoot: ${workspaceRoot}`);
      expect(timeoutError?.message).toContain(`homeRoot: ${homeRoot}`);

      await harness.signalTui("SIGTERM");
      expect(await harness.waitForExit(2_000)).toEqual({
        code: null,
        signal: "SIGTERM",
      });
      expect(harness.wrapperExit()).toEqual({ code: 143, signal: null });
    } finally {
      await harness.dispose();
    }

    expect(await pathExists(workspaceRoot)).toBe(false);
    expect(await pathExists(homeRoot)).toBe(false);
  },
  { timeout: 20_000 },
);

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
