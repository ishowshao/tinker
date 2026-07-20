import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { PromptInput, type PromptSubmission } from "../tui/components/prompt-input";
import { runtimeIdFactory } from "../ids/runtime-id";
import { imageAssetIdForBytes, type ImageAssetRef } from "../image/image-types";
import type { LoadedPromptHistoryRecord } from "../tui/prompt-history";

const ARROW_UP = "\u001b[A";
const ESCAPE = "\u001b";
const KEY_DELAY = 20;

describe("PromptInput image transactions", () => {
  test("attaches from @, locks admission, retains rejection, and clears only on acceptance", async () => {
    const firstOutcome = deferred<boolean>();
    const submissions: PromptSubmission[] = [];
    const imports: Array<{ path: string; count: number; signal: AbortSignal }> = [];
    const imported = importedImage("prompt", "shot.png");
    const view = render(
      <PromptInput
        modelName="kimi-k3"
        workspaceRoot="/workspace"
        fileLister={async () => ["shot.png"]}
        importImage={async (sourcePath, signal, count) => {
          imports.push({ path: sourcePath, count, signal });
          return imported;
        }}
        onSubmit={(submission) => {
          submissions.push(submission);
          return submissions.length === 1 ? firstOutcome.promise : true;
        }}
      />,
    );
    try {
      await press(view.stdin, "compare @sho");
      await waitForFrame(view.lastFrame, "shot.png");
      await press(view.stdin, "\r");
      await waitForFrame(view.lastFrame, "[Image #1]");

      expect(imports).toHaveLength(1);
      expect(imports[0]).toMatchObject({ path: "shot.png", count: 1 });
      expect(imports[0]?.signal.aborted).toBe(false);

      await press(view.stdin, "\r");
      await waitForFrame(view.lastFrame, "admitting turn");
      await press(view.stdin, "x", "\r");
      expect(submissions).toHaveLength(1);
      firstOutcome.resolve(false);
      await waitForFrame(view.lastFrame, "[Image #1]");
      await waitUntil(() => !plain(view.lastFrame()).includes("admitting turn"));

      expect(submissions[0]?.userMessage).toMatchObject({
        content: "compare [Image #1]",
        attachments: [
          {
            assetId: imported.asset.assetId,
            label: "[Image #1]",
            range: { start: 8, end: 18 },
            originalName: "shot.png",
          },
        ],
      });
      await press(view.stdin, "\r");
      await waitUntil(() => submissions.length === 2);
      expect(submissions[1]?.userMessage.content).toBe("compare [Image #1]");
      await waitUntil(() => !plain(view.lastFrame()).includes("[Image #1]"));
    } finally {
      view.cleanup();
    }
  });

  test("discards an attachment result that arrives after Escape", async () => {
    const result = deferred<ReturnType<typeof importedImage>>();
    let importSignal: AbortSignal | undefined;
    let submitCount = 0;
    const view = render(
      <PromptInput
        modelName="kimi-k3"
        workspaceRoot="/workspace"
        fileLister={async () => ["late.png"]}
        importImage={async (_path, signal) => {
          importSignal = signal;
          return result.promise;
        }}
        onSubmit={() => {
          submitCount += 1;
          return true;
        }}
      />,
    );
    try {
      await press(view.stdin, "inspect @late");
      await waitForFrame(view.lastFrame, "late.png");
      await press(view.stdin, "\r");
      await waitForFrame(view.lastFrame, "attaching image");
      await press(view.stdin, "ignored", "\r", ESCAPE);
      expect(importSignal?.aborted).toBe(true);
      result.resolve(importedImage("late", "late.png"));
      await waitUntil(() => !plain(view.lastFrame()).includes("attaching image"));

      expect(plain(view.lastFrame())).toContain("inspect @late");
      expect(plain(view.lastFrame())).not.toContain("[Image #1]");
      expect(submitCount).toBe(0);
    } finally {
      view.cleanup();
    }
  });

  test("offers explicit maintenance without changing or resubmitting the image draft", async () => {
    const actions: string[] = [];
    const submissions: PromptSubmission[] = [];
    const view = render(
      <PromptInput
        modelName="kimi-k3"
        workspaceRoot="/workspace"
        fileLister={async () => ["large.png"]}
        importImage={async () => importedImage("large", "large.png")}
        onSubmit={(submission) => {
          submissions.push(submission);
          return {
            kind: "maintenance_offer",
            reason: "media_aggregate",
            message: "Too many active images.",
          };
        }}
        onMaintenance={async (action) => {
          actions.push(action);
        }}
      />,
    );
    try {
      await press(view.stdin, "review @large");
      await waitForFrame(view.lastFrame, "large.png");
      await press(view.stdin, "\r");
      await waitForFrame(view.lastFrame, "[Image #1]");
      await press(view.stdin, "\r");
      await waitForFrame(view.lastFrame, "Context maintenance");

      expect(plain(view.lastFrame())).toContain("Too many active images.");
      await press(view.stdin, "n");
      await waitUntil(() => actions.length === 1);
      await waitUntil(() => !plain(view.lastFrame()).includes("Running new session"));
      expect(actions).toEqual(["new_session"]);
      expect(submissions).toHaveLength(1);
      expect(plain(view.lastFrame())).toContain("review [Image #1]");
    } finally {
      view.cleanup();
    }
  });

  test("verifies v2 history asynchronously and restores it with a fresh ID", async () => {
    const originalId = runtimeIdFactory.createImageAttachmentId();
    const asset = imageAsset("history", 7);
    const records: LoadedPromptHistoryRecord[] = [
      {
        kind: "valid",
        lineNumber: 1,
        entry: {
          version: 2,
          text: "old [Image #1]",
          elements: [
            {
              kind: "image",
              attachmentId: originalId,
              label: "[Image #1]",
              range: { start: 4, end: 14 },
            },
          ],
          attachments: [
            {
              attachmentId: originalId,
              asset,
              originalName: "history.png",
            },
          ],
        },
      },
    ];
    const verification = deferred<void>();
    const verified: Array<readonly ImageAssetRef[]> = [];
    let submitted: PromptSubmission | undefined;
    const view = render(
      <PromptInput
        modelName="kimi-k3"
        workspaceRoot="/workspace"
        history={{ records }}
        verifyImageAssets={async (assets) => {
          verified.push(assets);
          return verification.promise;
        }}
        onSubmit={(submission) => {
          submitted = submission;
          return true;
        }}
      />,
    );
    try {
      await press(view.stdin, ARROW_UP);
      await waitForFrame(view.lastFrame, "restoring history");
      await press(view.stdin, "ignored", "\r");
      expect(submitted).toBeUndefined();
      verification.resolve();
      await waitForFrame(view.lastFrame, "old [Image #1]");
      expect(verified).toEqual([[asset]]);

      await press(view.stdin, "\r");
      await waitUntil(() => submitted !== undefined);
      expect(submitted?.userMessage.attachments?.[0]?.attachmentId).not.toBe(
        originalId,
      );
      expect(submitted?.userMessage.attachments?.[0]).toMatchObject({
        ...asset,
        label: "[Image #1]",
        range: { start: 4, end: 14 },
        originalName: "history.png",
      });
    } finally {
      view.cleanup();
    }
  });
});

function importedImage(seed: string, originalName: string) {
  return Object.freeze({
    asset: imageAsset(seed, Buffer.byteLength(seed)),
    originalName,
  });
}

function imageAsset(seed: string, byteLength: number): ImageAssetRef {
  return Object.freeze({
    assetId: imageAssetIdForBytes(Buffer.from(seed)),
    mimeType: "image/png",
    byteLength,
    width: 1,
    height: 1,
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function press(
  stdin: { write: (data: string) => void },
  ...keys: string[]
): Promise<void> {
  for (const key of keys) {
    stdin.write(key);
    await Bun.sleep(KEY_DELAY);
  }
}

async function waitForFrame(
  lastFrame: () => string | undefined,
  expected: string,
): Promise<void> {
  await waitUntil(() => plain(lastFrame()).includes(expected));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for PromptInput state.");
    }
    await Bun.sleep(10);
  }
}

function plain(value: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  return (value ?? "").replace(/\u001b\[[0-9;]*m/g, "");
}
