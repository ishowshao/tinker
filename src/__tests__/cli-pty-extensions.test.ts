import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveWorkspaceStorageRoot } from "../session/workspace-storage";
import {
  onlyNonEmptySession,
  promptHistoryEntries,
  quitTui,
  storedSessions,
  submitPrompt,
  waitForInitialFrame,
  waitForPromptReady,
  withSessionDatabase,
} from "./helpers/pty-product-test-support";
import {
  createPtyTuiFixture,
  type PtyTuiHarness,
  withPtyTui,
} from "./helpers/pty-tui-harness";

test(
  "PTY-109: compacts a large real observation and recalls its canonical content",
  async () => {
    await withPtyTui(
      {
        fakeModel: "pty-context-heavy",
        rows: 80,
        columns: 140,
        workspaceFiles: { "context-heavy.txt": contextHeavyFixture() },
      },
      async (harness) => {
        await waitForInitialFrame(harness);
        await submitPrompt(harness, "PTY_CONTEXT_HEAVY");
        await harness.waitForScreen("PTY_CONTEXT_HEAVY_DONE", {
          timeoutMs: 10_000,
        });
        for (let index = 1; index <= 8; index += 1) {
          const prompt = `PTY_CONTEXT_PAD_${index}`;
          await submitPrompt(harness, prompt);
          await harness.waitForScreen(`${prompt}_DONE`);
        }

        await submitPrompt(harness, "/compact");
        await harness.waitForScreen("Context compacted: revision 1 -> 2", {
          timeoutMs: 10_000,
        });
        await submitPrompt(harness, "/status");
        await harness.waitForScreen("Measurement");
        expect(harness.screenText()).toContain("used:");

        await submitPrompt(harness, "PTY_CONTEXT_RECALL");
        await harness.waitForScreen("PTY_CONTEXT_RECALLED", {
          timeoutMs: 10_000,
        });
        expect(harness.screenText()).toContain("Recall");

        await quitTui(harness);
        const session = await onlyNonEmptySession(
          harness.workspaceRoot,
          harness.homeRoot,
        );
        await assertContextRevision(
          harness.workspaceRoot,
          harness.homeRoot,
          session,
          "swap_only",
        );
        await assertCanonicalRecall(harness.workspaceRoot, harness.homeRoot, session);
      },
    );
  },
  { timeout: 40_000 },
);

test(
  "PTY-109: retires a cold prefix and recalls history outside the active request",
  async () => {
    await withPtyTui(
      {
        fakeModel: "pty-context-heavy",
        rows: 100,
        columns: 140,
        workspaceFiles: { "context-heavy.txt": contextHeavyFixture() },
      },
      async (harness) => {
        await waitForInitialFrame(harness);
        await submitPrompt(harness, "PTY_CONTEXT_HEAVY");
        await harness.waitForScreen("PTY_CONTEXT_HEAVY_DONE", {
          timeoutMs: 10_000,
        });
        for (let index = 1; index <= 9; index += 1) {
          const prompt = `PTY_CONTEXT_PAD_${index}`;
          await submitPrompt(harness, prompt);
          await harness.waitForScreen(`${prompt}_DONE`);
        }

        await submitPrompt(harness, "/compact retire");
        await harness.waitForScreen("Context prefix retired: revision 1 -> 2", {
          timeoutMs: 10_000,
        });
        expect(harness.screenText()).toContain("Older history");
        expect(harness.screenText()).toContain(
          "remains available through RecallSearch and RecallGet.",
        );
        await submitPrompt(harness, "/status");
        await harness.waitForScreen("Measurement");

        await submitPrompt(harness, "PTY_CONTEXT_RECALL");
        await harness.waitForScreen("PTY_CONTEXT_RECALLED", {
          timeoutMs: 10_000,
        });

        await quitTui(harness);
        const session = await onlyNonEmptySession(
          harness.workspaceRoot,
          harness.homeRoot,
        );
        expect(session.turnCount).toBe(11);
        await assertContextRevision(
          harness.workspaceRoot,
          harness.homeRoot,
          session,
          "prefix_retirement",
        );
        await assertCanonicalRecall(harness.workspaceRoot, harness.homeRoot, session);
      },
    );
  },
  { timeout: 50_000 },
);

test(
  "PTY-110: materializes an image and restores its Prompt and resumed timeline",
  async () => {
    const fixture = await createPtyTuiFixture({
      workspaceFiles: {
        "fixture.png": fixturePng(),
        "models.json": imageModelProfilesJson(),
      },
    });
    const environment = { TINKER_MODELS: "models.json" };
    let first: PtyTuiHarness | undefined;
    let second: PtyTuiHarness | undefined;
    try {
      first = await fixture.start({
        fakeModel: "pty-image",
        rows: 60,
        columns: 140,
        environment,
      });
      await waitForInitialFrame(first);
      await waitForPromptReady(first);
      await first.type("@fixture");
      await first.waitForScreen("❯ fixture.png");
      await first.press("enter");
      await first.waitForScreen(
        (screen) =>
          screen.includes("[Image #1]") && !screen.includes("attaching image"),
        { message: "attached fixture image draft" },
      );
      await first.type("describe fixture");
      await first.waitForScreen("[Image #1] describe fixture");
      await first.press("enter");
      await first.waitForScreen("PTY_IMAGE_DONE", { timeoutMs: 10_000 });
      expect(first.screenText()).toContain("[Image #1] (fixture.png)");

      await waitForPromptReady(first);
      await first.press("up");
      await first.waitForScreen((screen) => occurrences(screen, "[Image #1]") >= 2, {
        message: "image Prompt restored from history",
      });
      await first.press("down");
      await waitForPromptReady(first);
      await quitTui(first);
      await first.dispose();

      const session = (
        await storedSessions(fixture.workspaceRoot, fixture.homeRoot)
      ).find((candidate) => candidate.turnCount === 1);
      if (session === undefined) {
        throw new Error("Expected one image PTY session.");
      }
      const assetsBeforeResume = await imageAssetNames(
        fixture.workspaceRoot,
        fixture.homeRoot,
      );
      expect(assetsBeforeResume).toHaveLength(1);

      second = await fixture.start({
        fakeModel: "pty-image",
        rows: 60,
        columns: 140,
        environment,
      });
      await waitForInitialFrame(second);
      await submitPrompt(second, `/resume ${session.sessionId}`);
      await second.waitForScreen(`Resumed session ${session.sessionId}.`, {
        timeoutMs: 10_000,
      });
      expect(second.screenText()).toContain("[Image #1] (fixture.png)");
      await waitForPromptReady(second);
      await second.press("up");
      await second.waitForScreen((screen) => occurrences(screen, "[Image #1]") >= 2, {
        message: "resumed image Prompt restored from history",
      });
      await second.press("down");
      await waitForPromptReady(second);
      await quitTui(second);

      expect(await imageAssetNames(fixture.workspaceRoot, fixture.homeRoot)).toEqual(
        assetsBeforeResume,
      );
      await withSessionDatabase(
        fixture.workspaceRoot,
        fixture.homeRoot,
        session,
        (database) => {
          expect(
            database
              .query(
                `SELECT mia.label, mia.original_name, ia.mime_type,
                      ia.byte_length, ia.width, ia.height
               FROM message_image_attachments mia
               JOIN image_assets ia ON ia.asset_id = mia.asset_id`,
              )
              .all(),
          ).toEqual([
            {
              label: "[Image #1]",
              original_name: "fixture.png",
              mime_type: "image/png",
              byte_length: fixturePng().byteLength,
              width: 1,
              height: 1,
            },
          ]);
        },
      );
    } finally {
      await second?.dispose();
      await first?.dispose();
      await fixture.dispose();
    }
  },
  { timeout: 40_000 },
);

test(
  "PTY-111: status, Skills, and MCP panels stay local until a real Prompt",
  async () => {
    await withPtyTui(
      {
        fakeModel: "pty-local-panels",
        rows: 70,
        columns: 140,
        environment: {
          TINKER_TEST_FAKE_MODEL_REQUEST_LOG: "model-requests.jsonl",
        },
        workspaceFiles: extensionWorkspaceFiles(),
      },
      async (harness) => {
        await waitForInitialFrame(harness);
        await submitPrompt(harness, "/status");
        await harness.waitForScreen("Measurement");
        await submitPrompt(harness, "/skills");
        await harness.waitForScreen("pty-review (project)");
        await submitPrompt(harness, "/mcp");
        await harness.waitForScreen("fixture (connected, 1 tool)");
        expect(
          await Bun.file(
            path.join(harness.workspaceRoot, "model-requests.jsonl"),
          ).exists(),
        ).toBe(false);
        expect(
          await promptHistoryEntries(harness.workspaceRoot, harness.homeRoot),
        ).toEqual([]);

        await submitPrompt(harness, "PTY_LOCAL_AFTER_PANELS");
        await harness.waitForScreen("PTY_LOCAL_AFTER_PANELS_DONE");
        const requests = (
          await readFile(
            path.join(harness.workspaceRoot, "model-requests.jsonl"),
            "utf8",
          )
        )
          .trim()
          .split("\n")
          .map((line): unknown => JSON.parse(line) as unknown);
        expect(requests).toEqual([
          {
            mode: "pty-local-panels",
            model: "pty-test-model",
            prompt: "PTY_LOCAL_AFTER_PANELS",
            requestNumber: 1,
          },
        ]);

        await quitTui(harness);
        const session = await onlyNonEmptySession(
          harness.workspaceRoot,
          harness.homeRoot,
        );
        expect(session.turnCount).toBe(1);
        expect(
          await promptHistoryEntries(harness.workspaceRoot, harness.homeRoot),
        ).toEqual(["PTY_LOCAL_AFTER_PANELS"]);
      },
    );
  },
  { timeout: 40_000 },
);

test(
  "PTY-112: activates a Skill and keeps it bound after resume",
  async () => {
    const fixture = await createPtyTuiFixture({
      workspaceFiles: skillWorkspaceFiles(),
    });
    let first: PtyTuiHarness | undefined;
    let second: PtyTuiHarness | undefined;
    try {
      first = await fixture.start({
        fakeModel: "pty-skill-activate",
        rows: 70,
        columns: 140,
      });
      await waitForInitialFrame(first);
      await submitPrompt(first, "PTY_SKILL_START");
      await first.waitForScreen("PTY_SKILL_DONE", { timeoutMs: 10_000 });
      expect(first.screenText()).toContain("skill pty-review loaded");
      await submitPrompt(first, "/skills");
      await first.waitForScreen("pty-review (project, active)");
      await quitTui(first);
      await first.dispose();

      const session = (
        await storedSessions(fixture.workspaceRoot, fixture.homeRoot)
      ).find((candidate) => candidate.turnCount === 1);
      if (session === undefined) {
        throw new Error("Expected one Skill PTY session.");
      }

      second = await fixture.start({
        fakeModel: "pty-skill-activate",
        rows: 70,
        columns: 140,
      });
      await waitForInitialFrame(second);
      await submitPrompt(second, `/resume ${session.sessionId}`);
      await second.waitForScreen(`Resumed session ${session.sessionId}.`, {
        timeoutMs: 10_000,
      });
      await submitPrompt(second, "/skills");
      await second.waitForScreen("pty-review (project, active)");
      await submitPrompt(second, "PTY_SKILL_AFTER_RESUME");
      await second.waitForScreen("PTY_SKILL_RESUMED");
      await quitTui(second);

      await withSessionDatabase(
        fixture.workspaceRoot,
        fixture.homeRoot,
        session,
        (database) => {
          expect(
            database
              .query("SELECT name, state FROM skill_activations ORDER BY created_at")
              .all(),
          ).toEqual([{ name: "pty-review", state: "promoted" }]);
          expect(
            database
              .query("SELECT kind FROM context_revisions WHERE kind = 'skills_update'")
              .all(),
          ).toEqual([{ kind: "skills_update" }]);
          expect(
            database
              .query("SELECT COUNT(*) AS count FROM turns WHERE status = 'completed'")
              .get(),
          ).toEqual({ count: 2 });
        },
      );
    } finally {
      await second?.dispose();
      await first?.dispose();
      await fixture.dispose();
    }
  },
  { timeout: 40_000 },
);

test(
  "PTY-112: calls a real stdio MCP tool exactly once with exact arguments",
  async () => {
    await withPtyTui(
      {
        fakeModel: "pty-mcp-call",
        rows: 70,
        columns: 140,
        workspaceFiles: mcpWorkspaceFiles(true),
      },
      async (harness) => {
        await waitForInitialFrame(harness);
        await submitPrompt(harness, "PTY_MCP_START");
        await harness.waitForScreen("PTY_MCP_DONE", { timeoutMs: 10_000 });
        const screen = harness.screenText();
        expect(screen).toContain("mcp__fixture__echo");
        expect(screen).toContain("echo: PTY_MCP_PAYLOAD");

        const calls = (
          await readFile(path.join(harness.workspaceRoot, "mcp-calls.jsonl"), "utf8")
        )
          .trim()
          .split("\n")
          .map((line): unknown => JSON.parse(line) as unknown);
        expect(calls).toEqual([
          {
            name: "echo",
            arguments: { message: "PTY_MCP_PAYLOAD" },
          },
        ]);

        await quitTui(harness);
        const session = await onlyNonEmptySession(
          harness.workspaceRoot,
          harness.homeRoot,
        );
        await withSessionDatabase(
          harness.workspaceRoot,
          harness.homeRoot,
          session,
          (database) => {
            expect(
              database
                .query(
                  `SELECT messages.name
                 FROM tool_results
                 JOIN messages ON messages.message_id = tool_results.tool_message_id
                 WHERE messages.name = 'mcp__fixture__echo'`,
                )
                .all(),
            ).toEqual([{ name: "mcp__fixture__echo" }]);
          },
        );
      },
    );
  },
  { timeout: 40_000 },
);

function contextHeavyFixture(): string {
  return [
    "PTY_CONTEXT_ORIGINAL_MARKER",
    ...Array.from(
      { length: 6_600 },
      (_, index) =>
        `context-payload-${String(index).padStart(5, "0")} abcdefghijklmnop`,
    ),
  ].join("\n");
}

async function assertContextRevision(
  workspaceRoot: string,
  homeRoot: string,
  session: Awaited<ReturnType<typeof onlyNonEmptySession>>,
  kind: "swap_only" | "prefix_retirement",
): Promise<void> {
  await withSessionDatabase(workspaceRoot, homeRoot, session, (database) => {
    const revision = database
      .query(
        `SELECT kind, revision_number, keep_from_ordinal,
                active_override_count, retired_turn_count
         FROM context_revisions
         WHERE kind = ?`,
      )
      .get(kind);
    expect(revision).toMatchObject({ kind, revision_number: 2 });
    if (kind === "swap_only") {
      expect(revision).toMatchObject({ keep_from_ordinal: 1 });
      expect(
        (revision as { active_override_count: number }).active_override_count,
      ).toBe(1);
    } else {
      expect(
        (revision as { keep_from_ordinal: number }).keep_from_ordinal,
      ).toBeGreaterThan(1);
      expect(
        (revision as { retired_turn_count: number }).retired_turn_count,
      ).toBeGreaterThan(0);
    }
  });
}

async function assertCanonicalRecall(
  workspaceRoot: string,
  homeRoot: string,
  session: Awaited<ReturnType<typeof onlyNonEmptySession>>,
): Promise<void> {
  await withSessionDatabase(workspaceRoot, homeRoot, session, (database) => {
    expect(
      database
        .query(
          `SELECT COUNT(*) AS count
           FROM messages
           WHERE name = 'Read'
             AND content LIKE '%PTY_CONTEXT_ORIGINAL_MARKER%'`,
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database
        .query(
          `SELECT COUNT(*) AS count
           FROM tool_results
           JOIN messages ON messages.message_id = tool_results.tool_message_id
           WHERE messages.name IN ('RecallSearch', 'RecallGet')`,
        )
        .get(),
    ).toEqual({ count: 2 });
  });
}

function fixturePng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
}

function imageModelProfilesJson(): string {
  return `${JSON.stringify({
    default: "image",
    profiles: {
      image: {
        model: "image-model",
        apiBase: "https://api.example.test/v1",
        apiKey: "image-placeholder",
        contextWindowTokens: 128 * 1_024,
        maxSupportedOutputTokens: 16 * 1_024,
        includeReasoningContent: false,
        stream: false,
        inputModalities: ["text", "image"],
      },
    },
  })}\n`;
}

function skillWorkspaceFiles(): Readonly<Record<string, string>> {
  return {
    ".agents/skills/pty-review/SKILL.md": [
      "---",
      "name: pty-review",
      "description: Review the PTY fixture",
      "---",
      "PTY_SKILL_INSTRUCTIONS",
      "Always return the deterministic PTY marker.",
      "",
    ].join("\n"),
  };
}

function extensionWorkspaceFiles(): Readonly<Record<string, string>> {
  return {
    ...skillWorkspaceFiles(),
    ...mcpWorkspaceFiles(false),
  };
}

function mcpWorkspaceFiles(logCalls: boolean): Readonly<Record<string, string>> {
  return {
    ".mcp.json": JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [path.join(import.meta.dir, "fixtures/fake-mcp-server.ts")],
          ...(logCalls ? { env: { TINKER_TEST_MCP_CALL_LOG: "mcp-calls.jsonl" } } : {}),
        },
      },
    }),
  };
}

async function imageAssetNames(
  workspaceRoot: string,
  homeRoot: string,
): Promise<string[]> {
  return (
    await readdir(
      path.join(
        await resolveWorkspaceStorageRoot(workspaceRoot, homeRoot),
        "assets",
        "images",
      ),
    )
  ).sort();
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
