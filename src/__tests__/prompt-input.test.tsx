import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { PromptInput } from "../tui/components/prompt-input";

const ARROW_UP = "[A";
const ARROW_DOWN = "[B";
const ARROW_LEFT = "[D";
const BACKSPACE = "";

const KEY_DELAY = 15;

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
  test("renders typed characters and submits on enter", async () => {
    const submitted: string[] = [];
    const { stdin, lastFrame, cleanup } = render(
      <PromptInput onSubmit={(value) => submitted.push(value)} />,
    );

    await press(stdin, "abc");
    expect(stripAnsi(lastFrame())).toContain("abc");

    await press(stdin, "\r");
    expect(submitted).toEqual(["abc"]);
    expect(stripAnsi(lastFrame())).not.toContain("abc");
    cleanup();
  });

  test("recalls history entries with the up arrow", async () => {
    const history = { entries: ["first prompt", "second prompt"] };
    const submitted: string[] = [];
    const { stdin, lastFrame, cleanup } = render(
      <PromptInput history={history} onSubmit={(value) => submitted.push(value)} />,
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
      <PromptInput history={history} onSubmit={(value) => submitted.push(value)} />,
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
      <PromptInput history={history} onSubmit={(value) => submitted.push(value)} />,
    );

    await press(stdin, ARROW_UP, BACKSPACE, "t again", "\r");
    expect(submitted).toEqual(["run test again"]);
    cleanup();
  });

  test("inserts characters at the cursor position", async () => {
    const submitted: string[] = [];
    const { stdin, cleanup } = render(
      <PromptInput onSubmit={(value) => submitted.push(value)} />,
    );

    await press(stdin, "ac", ARROW_LEFT, "b", "\r");
    expect(submitted).toEqual(["abc"]);
    cleanup();
  });

  test("up arrow without history keeps the placeholder", async () => {
    const { stdin, lastFrame, cleanup } = render(
      <PromptInput placeholder="type here" onSubmit={() => undefined} />,
    );

    await press(stdin, ARROW_UP);
    expect(stripAnsi(lastFrame())).toContain("type here");
    cleanup();
  });

  test("ignores input while disabled", async () => {
    const submitted: string[] = [];
    const { stdin, lastFrame, cleanup } = render(
      <PromptInput
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
