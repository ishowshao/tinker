import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { PromptInput } from "../tui/components/prompt-input";

const ARROW_UP = "[A";
const ARROW_DOWN = "[B";
const ARROW_LEFT = "[D";
const BACKSPACE = "";
const CTRL_A = "\u0001";
const CTRL_E = "\u0005";
const CTRL_U = "\u0015";
const PASTE_START = "[200~";
const PASTE_END = "[201~";

const KEY_DELAY = 15;
const MODEL_NAME = "deepseek-v4-flash";
const WORKSPACE_ROOT = path.join(os.homedir(), "htdocs", "tinker");

function stripAnsi(value: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  return (value ?? "").replace(/\[[0-9;]*m/g, "");
}

async function press(stdin: { write: (data: string) => void }, ...keys: string[]) {
  for (const key of keys) {
    stdin.write(key);
    await Bun.sleep(KEY_DELAY);
  }
}

describe("prompt input", () => {
  test("renders full-width horizontal borders without side borders", () => {
    const { lastFrame, stdout, cleanup } = render(
      <PromptInput
        modelName={MODEL_NAME}
        workspaceRoot={WORKSPACE_ROOT}
        placeholder="ready"
        onSubmit={() => undefined}
      />,
    );

    const lines = stripAnsi(lastFrame()).split("\n");
    expect(lines[0]).toBe("─".repeat(stdout.columns));
    expect(lines[1]).toBe("ready");
    expect(lines[2]).toBe("─".repeat(stdout.columns));
    cleanup();
  });

  test("renders model and workspace information below the input", () => {
    const { lastFrame, cleanup } = render(
      <PromptInput
        modelName={MODEL_NAME}
        workspaceRoot={WORKSPACE_ROOT}
        onSubmit={() => undefined}
      />,
    );

    const lines = stripAnsi(lastFrame()).split("\n");
    expect(lines[3]).toBe(`${MODEL_NAME} · ~/htdocs/tinker`);
    cleanup();
  });

  test("appends the Git branch to the information line", () => {
    const { lastFrame, cleanup } = render(
      <PromptInput
        modelName={MODEL_NAME}
        workspaceRoot={WORKSPACE_ROOT}
        gitBranch="feature/tui-info"
        onSubmit={() => undefined}
      />,
    );

    const lines = stripAnsi(lastFrame()).split("\n");
    expect(lines[3]).toBe(`${MODEL_NAME} · ~/htdocs/tinker · feature/tui-info`);
    cleanup();
  });

  test("keeps absolute workspace paths for Home itself and external directories", () => {
    const home = os.homedir();
    const homeRender = render(
      <PromptInput
        modelName={MODEL_NAME}
        workspaceRoot={home}
        onSubmit={() => undefined}
      />,
    );
    const externalRender = render(
      <PromptInput
        modelName={MODEL_NAME}
        workspaceRoot="/tmp/external-workspace"
        onSubmit={() => undefined}
      />,
    );

    expect(stripAnsi(homeRender.lastFrame()).split("\n")[3]).toBe(
      `${MODEL_NAME} · ${home}`,
    );
    expect(stripAnsi(externalRender.lastFrame()).split("\n")[3]).toBe(
      `${MODEL_NAME} · /tmp/external-workspace`,
    );
    homeRender.cleanup();
    externalRender.cleanup();
  });

  test("renders typed characters and submits on enter", async () => {
    const submitted: string[] = [];
    const { stdin, lastFrame, cleanup } = render(
      <PromptInput
        modelName={MODEL_NAME}
        workspaceRoot={WORKSPACE_ROOT}
        onSubmit={(value) => submitted.push(value)}
      />,
    );

    await press(stdin, "abc");
    expect(stripAnsi(lastFrame())).toContain("abc");

    await press(stdin, "\r");
    expect(submitted).toEqual(["abc"]);
    expect(stripAnsi(lastFrame())).not.toContain("abc");
    cleanup();
  });

  test("keeps multiline pasted text until Return submits it", async () => {
    const submitted: string[] = [];
    const { stdin, lastFrame, cleanup } = render(
      <PromptInput
        modelName={MODEL_NAME}
        workspaceRoot={WORKSPACE_ROOT}
        onSubmit={(value) => submitted.push(value)}
      />,
    );

    await press(stdin, `${PASTE_START}first line\r\nsecond line${PASTE_END}`);

    expect(submitted).toEqual([]);
    expect(stripAnsi(lastFrame())).toContain("first line\nsecond line");

    await press(stdin, "!", "\r");
    expect(submitted).toEqual(["first line\nsecond line!"]);
    cleanup();
  });

  test("keeps newlines from an unbracketed multiline input chunk", async () => {
    const submitted: string[] = [];
    const { stdin, cleanup } = render(
      <PromptInput
        modelName={MODEL_NAME}
        workspaceRoot={WORKSPACE_ROOT}
        onSubmit={(value) => submitted.push(value)}
      />,
    );

    await press(stdin, "alpha\nbeta");
    expect(submitted).toEqual([]);

    await press(stdin, "\r");
    expect(submitted).toEqual(["alpha\nbeta"]);
    cleanup();
  });

  test("repeatedly moves across line boundaries with Ctrl+A and Ctrl+E", async () => {
    const submitted: string[] = [];
    const { stdin, cleanup } = render(
      <PromptInput
        modelName={MODEL_NAME}
        workspaceRoot={WORKSPACE_ROOT}
        onSubmit={(value) => submitted.push(value)}
      />,
    );

    await press(stdin, `${PASTE_START}first\nsecond\nthird${PASTE_END}`);
    await press(stdin, CTRL_A, CTRL_A, ">", CTRL_E, CTRL_E, "<", "\r");

    expect(submitted).toEqual(["first\n>second\nthird<"]);
    cleanup();
  });

  test("deletes left and then joins lines with repeated Ctrl+U", async () => {
    const submitted: string[] = [];
    const { stdin, cleanup } = render(
      <PromptInput
        modelName={MODEL_NAME}
        workspaceRoot={WORKSPACE_ROOT}
        onSubmit={(value) => submitted.push(value)}
      />,
    );

    await press(stdin, `${PASTE_START}first\nsecond${PASTE_END}`);
    await press(stdin, ARROW_LEFT, ARROW_LEFT, ARROW_LEFT);
    await press(stdin, CTRL_U, CTRL_U, "-", "\r");

    expect(submitted).toEqual(["first-ond"]);
    cleanup();
  });

  test("recalls history entries with the up arrow", async () => {
    const history = { entries: ["first prompt", "second prompt"] };
    const submitted: string[] = [];
    const { stdin, lastFrame, cleanup } = render(
      <PromptInput
        modelName={MODEL_NAME}
        workspaceRoot={WORKSPACE_ROOT}
        history={history}
        onSubmit={(value) => submitted.push(value)}
      />,
    );

    await press(stdin, ARROW_UP);
    expect(stripAnsi(lastFrame())).toContain("second prompt");

    await press(stdin, ARROW_UP);
    expect(stripAnsi(lastFrame())).toContain("first prompt");

    await press(stdin, ARROW_UP);
    expect(stripAnsi(lastFrame())).toContain("first prompt");

    await press(stdin, "\r");
    expect(submitted).toEqual(["first prompt"]);
    cleanup();
  });

  test("restores the draft when navigating back down", async () => {
    const history = { entries: ["old prompt"] };
    const submitted: string[] = [];
    const { stdin, lastFrame, cleanup } = render(
      <PromptInput
        modelName={MODEL_NAME}
        workspaceRoot={WORKSPACE_ROOT}
        history={history}
        onSubmit={(value) => submitted.push(value)}
      />,
    );

    await press(stdin, "draft");
    await press(stdin, ARROW_UP);
    expect(stripAnsi(lastFrame())).toContain("old prompt");

    await press(stdin, ARROW_DOWN);
    expect(stripAnsi(lastFrame())).toContain("draft");

    await press(stdin, "\r");
    expect(submitted).toEqual(["draft"]);
    cleanup();
  });

  test("submits an edited history entry", async () => {
    const history = { entries: ["run test"] };
    const submitted: string[] = [];
    const { stdin, cleanup } = render(
      <PromptInput
        modelName={MODEL_NAME}
        workspaceRoot={WORKSPACE_ROOT}
        history={history}
        onSubmit={(value) => submitted.push(value)}
      />,
    );

    await press(stdin, ARROW_UP, BACKSPACE, "t again", "\r");
    expect(submitted).toEqual(["run test again"]);
    cleanup();
  });

  test("inserts characters at the cursor position", async () => {
    const submitted: string[] = [];
    const { stdin, cleanup } = render(
      <PromptInput
        modelName={MODEL_NAME}
        workspaceRoot={WORKSPACE_ROOT}
        onSubmit={(value) => submitted.push(value)}
      />,
    );

    await press(stdin, "ac", ARROW_LEFT, "b", "\r");
    expect(submitted).toEqual(["abc"]);
    cleanup();
  });

  test("up arrow without history keeps the placeholder", async () => {
    const { stdin, lastFrame, cleanup } = render(
      <PromptInput
        modelName={MODEL_NAME}
        workspaceRoot={WORKSPACE_ROOT}
        placeholder="type here"
        onSubmit={() => undefined}
      />,
    );

    await press(stdin, ARROW_UP);
    expect(stripAnsi(lastFrame())).toContain("type here");
    cleanup();
  });

  test("ignores input while disabled", async () => {
    const submitted: string[] = [];
    const { stdin, lastFrame, cleanup } = render(
      <PromptInput
        modelName={MODEL_NAME}
        workspaceRoot={WORKSPACE_ROOT}
        isDisabled
        placeholder="waiting"
        onSubmit={(value) => submitted.push(value)}
      />,
    );

    await press(stdin, "abc", "\r");
    expect(submitted).toEqual([]);
    expect(stripAnsi(lastFrame())).toContain("waiting");
    cleanup();
  });
});
