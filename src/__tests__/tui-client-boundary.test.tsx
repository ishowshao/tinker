import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "../tui/app";
import {
  completedResult,
  createProjectionStore,
  createSessionController,
  submitInput,
  waitForFrame,
} from "./helpers/tui-components-support";

describe("TUI asynchronous client boundary", () => {
  test.each([
    "success",
    "failure",
  ] as const)("waits for YOLO acknowledgement before reporting %s", async (outcome) => {
    const response = Promise.withResolvers<void>();
    const calls: boolean[] = [];
    const controller = createSessionController(createProjectionStore(), async () =>
      completedResult(),
    );
    controller.getBinding().setYoloMode = async (enabled) => {
      calls.push(enabled);
      await response.promise;
    };
    const { stdin, lastFrame, cleanup } = render(
      <App sessionController={controller} />,
    );
    try {
      await submitInput(stdin, "/yolo on");
      expect(calls).toEqual([true]);
      expect(lastFrame()).not.toContain("YOLO enabled for this session");
      if (outcome === "success") {
        response.resolve();
        await waitForFrame(
          lastFrame,
          (frame) => frame.includes("YOLO enabled for this session"),
          "YOLO enabled for this session",
        );
      } else {
        response.reject(new Error("Client command rejected"));
        await waitForFrame(
          lastFrame,
          (frame) => frame.includes("Client command rejected"),
          "Client command rejected",
        );
        expect(lastFrame()).not.toContain("YOLO enabled for this session");
      }
    } finally {
      response.resolve();
      cleanup();
    }
  });

  test("copies the client response without opening a local session database", async () => {
    const controller = createSessionController(createProjectionStore(), async () =>
      completedResult(),
    );
    let reads = 0;
    controller.getBinding().readLastResponse = async () => {
      reads += 1;
      return "Client-owned **response**";
    };
    const copied: string[] = [];
    const { stdin, lastFrame, cleanup } = render(
      <App
        sessionController={controller}
        writeClipboard={async (text) => {
          copied.push(text);
        }}
      />,
    );
    try {
      await submitInput(stdin, "/copy");
      await waitForFrame(
        lastFrame,
        (frame) => frame.includes("Copied last response as Markdown."),
        "Copied last response as Markdown.",
      );
      expect(reads).toBe(1);
      expect(copied).toEqual(["Client-owned **response**"]);
    } finally {
      cleanup();
    }
  });
});
