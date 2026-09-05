import { writeFile } from "node:fs/promises";
import path from "node:path";
import { startPtyTui } from "../src/__tests__/helpers/pty-tui-harness";
import { command } from "./remote/certificates";

// Run serially with iOS/live relay journeys: this intentionally stops local components.
const root = path.resolve(import.meta.dir, "..");
const directory = path.resolve(
  process.argv[2] ?? path.join(root, ".tinker/remote-local"),
);
const component = (action: string, name: string) =>
  command([
    process.execPath,
    path.join(root, "scripts/remote-local.ts"),
    action,
    name,
    "--directory",
    directory,
  ]);
async function waitForService(running: boolean) {
  for (let index = 0; index < 100; index++) {
    const status = await component("status", "service");
    if (status.includes(running ? "running" : "stopped")) return;
    await Bun.sleep(100);
  }
  throw new Error("Service did not reach the required regression state.");
}
const results = [];
try {
  for (const state of ["service_absent", "service_running", "relay_disconnected"]) {
    if (state === "service_absent") {
      await component("down", "service");
      await waitForService(false);
    }
    if (state === "service_running") {
      await component("up", "service");
      await waitForService(true);
    }
    if (state === "relay_disconnected") await component("down", "relay");
    const started = performance.now();
    const terminal = await startPtyTui({
      fakeModel: "pty-prompt-input",
      rows: 40,
      columns: 120,
    });
    const startupMs = performance.now() - started;
    try {
      const turnStarted = performance.now();
      await terminal.paste("first\n>second\n中文<");
      await terminal.waitForScreen("first\n>second\n中文<");
      await terminal.press("enter");
      await terminal.waitForScreen("PTY_PROMPT_FIRST_DONE");
      await terminal.waitForPromptReady();
      const turnMs = performance.now() - turnStarted;
      await terminal.type("/quit");
      await terminal.waitForScreen("/quit");
      await terminal.press("enter");
      const exit = await terminal.waitForExit();
      if (exit?.code !== 0)
        throw new Error(terminal.diagnosticText("Clean /quit exit"));
      results.push({
        state,
        startupMs: Math.round(startupMs),
        turnMs: Math.round(turnMs),
        exitCode: exit.code,
        realPty: true,
        model: "deterministic fixture",
      });
      console.log(
        `${state}: native PTY prompt/Unicode/response/quit passed (${Math.round(startupMs)} ms startup)`,
      );
    } finally {
      await terminal.dispose();
    }
  }
} finally {
  await component("up", "relay");
  await component("up", "service");
}
await writeFile(
  path.join(directory, "tui-acceptance.json"),
  JSON.stringify({ date: new Date().toISOString(), results }, null, 2),
  { mode: 0o600 },
);
