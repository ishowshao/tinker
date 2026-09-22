import { expect, test } from "bun:test";
import { CapabilityModel, catalog } from "./helpers/remote-capability-model";
import { remoteTuiFixture } from "./helpers/remote-tui-test-support";
import { startPtyTui } from "./helpers/pty-tui-harness";

test("PTY: service configuration and maintenance retain the full TUI command flow", async () => {
  const f = await remoteTuiFixture(new CapabilityModel(), catalog);
  let harness: Awaited<ReturnType<typeof startPtyTui>> | undefined;
  try {
    harness = await startPtyTui({
      fakeModel: "must-not-run",
      rows: 45,
      columns: 140,
      cliArgs: [
        "connect",
        "--config",
        f.configPath,
        "--tui",
        "--workspace",
        "test",
        "--session",
        f.sessionId,
      ],
    });
    const command = async (text: string, output: string) => {
      await harness!.waitForPromptReady();
      await harness!.type(text);
      await harness!.waitForScreen(text);
      await harness!.press("enter");
      await harness!.waitForScreen(output);
    };
    await command("/model large", "large-model");
    await command("/reasoning high", 'Reasoning effort set to "high"');
    await command(
      "/reasoning reset",
      'Reasoning effort reset to profile default "low"',
    );
    await command("CAPABILITY_PROMPT", "CAPABILITY_DONE");
    await command("/compact", "Context is already below the compact target");
    await command("/compact retire", "Context is already below");
    await command("/fork", "Cloned current session as");
    expect(harness.screenText()).toContain("CAPABILITY_DONE");
    await command("/undo", "Nothing");
    await harness.waitForPromptReady();
    await harness.type("/quit");
    await harness.waitForScreen("Exit the TUI");
    await harness.press("enter");
    expect(await harness.waitForExit(3000)).toEqual({ code: 0, signal: null });
  } finally {
    await harness?.dispose();
    await f.cleanup();
  }
}, 30000);

test("PTY: a server workspace image uses the original attachment chip and survives service cloning", async () => {
  const sharp = (await import("sharp")).default;
  const model = new CapabilityModel();
  const f = await remoteTuiFixture({
    inputModalities: ["text", "image"],
    toolResultModalities: ["text"],
    messageProtocol: model.messageProtocol,
    prepare: model.prepare.bind(model),
    request: model.request.bind(model),
  });
  let harness;
  try {
    const filename = `${f.workspace}/terminal-image.png`;
    await Bun.write(
      filename,
      await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } })
        .png()
        .toBuffer(),
    );
    harness = await startPtyTui({
      fakeModel: "must-not-run",
      rows: 45,
      columns: 140,
      cliArgs: [
        "connect",
        "--config",
        f.configPath,
        "--tui",
        "--workspace",
        "test",
        "--session",
        f.sessionId,
      ],
    });
    await harness.type("@terminal-image");
    await harness.waitForScreen("❯ terminal-image.png");
    await harness.press("enter");
    await harness.waitForScreen("[Image #1]");
    await harness.type("describe");
    await harness.waitForScreen("[Image #1] describe");
    await harness.press("enter");
    await harness.waitForScreen("CAPABILITY_DONE");
    expect(model.inputs[0]).toContain("terminal-image.png");
    await harness.waitForPromptReady();
    await harness.type("/fork");
    await harness.waitForScreen("/fork");
    await harness.press("enter");
    await harness.waitForScreen("Cloned current session as");
    expect(harness.screenText()).toContain("[Image #1]");
  } finally {
    await harness?.dispose();
    await f.cleanup();
  }
}, 20000);
