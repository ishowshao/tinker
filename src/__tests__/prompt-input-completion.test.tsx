import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { PromptInput } from "../tui/components/prompt-input";
import type { SlashCommand } from "../tui/slash-commands";

describe("prompt input slash commands", () => {
  const modelName = "model";

  const workspaceRoot = "/tmp/tinker";

  const commands: readonly SlashCommand[] = [
    { name: "quit", description: "Exit the TUI" },
    { name: "quiet", description: "Toggle quiet mode" },
  ];

  test("shows suggestions while typing a slash command", async () => {
    const { stdin, lastFrame, cleanup } = render(
      <PromptInput
        modelName={modelName}
        workspaceRoot={workspaceRoot}
        commands={commands}
        onSubmit={() => true}
      />,
    );

    stdin.write("/qui");
    await Bun.sleep(25);

    expect(lastFrame()).toContain("❯ /quit");
    expect(lastFrame()).toContain("Exit the TUI");
    expect(lastFrame()).toContain("/quiet");
    expect(lastFrame()).not.toContain(modelName);
    cleanup();
  });

  test("completes the selected command with tab", async () => {
    const submitted: string[] = [];
    const { stdin, lastFrame, cleanup } = render(
      <PromptInput
        modelName={modelName}
        workspaceRoot={workspaceRoot}
        commands={commands}
        onSubmit={(value) => {
          submitted.push(value.userMessage.content);
          return true;
        }}
      />,
    );

    stdin.write("/q");
    await Bun.sleep(25);
    stdin.write("\t");
    await Bun.sleep(25);

    expect(lastFrame()).toContain("/quit");
    expect(lastFrame()).not.toContain("Exit the TUI");

    stdin.write("\r");
    await Bun.sleep(25);

    expect(submitted).toEqual(["/quit"]);
    cleanup();
  });

  test("accepts the selected suggestion on enter", async () => {
    const submitted: string[] = [];
    const { stdin, cleanup } = render(
      <PromptInput
        modelName={modelName}
        workspaceRoot={workspaceRoot}
        commands={commands}
        onSubmit={(value) => {
          submitted.push(value.userMessage.content);
          return true;
        }}
      />,
    );

    stdin.write("/q");
    await Bun.sleep(25);
    stdin.write("\r");
    await Bun.sleep(25);

    expect(submitted).toEqual(["/quit"]);
    cleanup();
  });

  test("navigates suggestions with arrow keys", async () => {
    const submitted: string[] = [];
    const { stdin, lastFrame, cleanup } = render(
      <PromptInput
        modelName={modelName}
        workspaceRoot={workspaceRoot}
        commands={commands}
        onSubmit={(value) => {
          submitted.push(value.userMessage.content);
          return true;
        }}
      />,
    );

    stdin.write("/q");
    await Bun.sleep(25);
    stdin.write("[B");
    await Bun.sleep(25);

    expect(lastFrame()).toContain("❯ /quiet");

    stdin.write("\r");
    await Bun.sleep(25);

    expect(submitted).toEqual(["/quiet"]);
    cleanup();
  });

  test("dismisses suggestions with escape and submits raw input", async () => {
    const submitted: string[] = [];
    const { stdin, lastFrame, cleanup } = render(
      <PromptInput
        modelName={modelName}
        workspaceRoot={workspaceRoot}
        commands={commands}
        onSubmit={(value) => {
          submitted.push(value.userMessage.content);
          return true;
        }}
      />,
    );

    stdin.write("/q");
    await Bun.sleep(25);
    stdin.write("");
    await Bun.sleep(25);

    expect(lastFrame()).not.toContain("Exit the TUI");
    expect(lastFrame()).toContain(modelName);

    stdin.write("\r");
    await Bun.sleep(25);

    expect(submitted).toEqual(["/q"]);
    cleanup();
  });

  test("reopens suggestions after escape when input changes", async () => {
    const { stdin, lastFrame, cleanup } = render(
      <PromptInput
        modelName={modelName}
        workspaceRoot={workspaceRoot}
        commands={commands}
        onSubmit={() => true}
      />,
    );

    stdin.write("/q");
    await Bun.sleep(25);
    stdin.write("");
    await Bun.sleep(25);
    stdin.write("u");
    await Bun.sleep(25);

    expect(lastFrame()).toContain("❯ /quit");
    cleanup();
  });

  test("keeps history navigation when no suggestions are shown", async () => {
    const { stdin, lastFrame, cleanup } = render(
      <PromptInput
        modelName={modelName}
        workspaceRoot={workspaceRoot}
        commands={commands}
        history={{ entries: ["fix the bug"] }}
        onSubmit={() => true}
      />,
    );

    stdin.write("[A");
    await Bun.sleep(25);

    expect(lastFrame()).toContain("fix the bug");
    cleanup();
  });
});
