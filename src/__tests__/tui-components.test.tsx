import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Header } from "../tui/components/header";
import { Timeline } from "../tui/components/timeline";
import { Footer } from "../tui/components/footer";

describe("tui components", () => {
  test("renders header metadata", () => {
    const { lastFrame, cleanup } = render(
      <Header
        modelName="deepseek-v4-flash"
        workspaceRoot="/tmp/tinker"
        runId="run-1"
      />,
    );

    expect(lastFrame()).toContain("deepseek-v4-flash");
    expect(lastFrame()).toContain("tinker");
    expect(lastFrame()).toContain("run-1");
    cleanup();
  });

  test("renders timeline tool status", () => {
    const { lastFrame, cleanup } = render(
      <Timeline
        events={[
          { type: "model.step.started", step: 1 },
          {
            type: "tool.started",
            step: 1,
            call: {
              id: "call_1",
              name: "Read",
              args: { file_path: "README.md" },
            },
          },
          {
            type: "tool.finished",
            step: 1,
            call: {
              id: "call_1",
              name: "Read",
              args: { file_path: "README.md" },
            },
            ok: true,
          },
        ]}
      />,
    );

    expect(lastFrame()).toContain("Read");
    expect(lastFrame()).toContain("README.md");
    expect(lastFrame()).toContain("ok");
    cleanup();
  });

  test("renders footer status", () => {
    const { lastFrame, cleanup } = render(<Footer status="done" />);

    expect(lastFrame()).toContain("done");
    cleanup();
  });

  test("renders final output without ok status prefix", () => {
    const { lastFrame, cleanup } = render(
      <Timeline
        items={[
          {
            id: "final-1",
            label: "assistant",
            text: "Completed the change.",
            status: "text",
          },
        ]}
      />,
    );

    expect(lastFrame()).toContain("- assistant");
    expect(lastFrame()).toContain("Completed the change.");
    expect(lastFrame()).not.toContain("final:");
    expect(lastFrame()).not.toContain("ok Completed");
    cleanup();
  });
});
