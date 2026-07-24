import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseSessionId, type SessionId } from "../../ids/runtime-id";
import { SessionCatalog, type SessionSummary } from "../../session/session-catalog";
import { sessionDatabasePath } from "../../session/session-store";
import { promptHistoryPath } from "../../cli/config";
import { PromptHistory } from "../../tui/prompt-history";
import type { PtyTuiHarness } from "./pty-tui-harness";

export async function waitForInitialFrame(harness: PtyTuiHarness): Promise<void> {
  await harness.waitForScreen("Tinker", {
    timeoutMs: 10_000,
    message: "initial Tinker frame",
  });
}

export async function waitForPromptReady(
  harness: PtyTuiHarness,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!harness.promptReady()) {
    if (harness.tuiExit() !== undefined || harness.wrapperExit() !== undefined) {
      throw new Error(harness.diagnosticText("editable Prompt input"));
    }
    if (Date.now() >= deadline) {
      throw new Error(harness.diagnosticText("editable Prompt input"));
    }
    await Bun.sleep(25);
  }
}

export async function submitPrompt(
  harness: PtyTuiHarness,
  prompt: string,
): Promise<void> {
  await waitForPromptReady(harness);
  await harness.type(prompt);
  await harness.waitForScreen(prompt, {
    timeoutMs: 2_000,
    message: `typed ${prompt}`,
  });
  await harness.press("enter");
}

export async function quitTui(harness: PtyTuiHarness): Promise<void> {
  await submitPrompt(harness, "/quit");
  const exit = await harness.waitForExit(2_000);
  if (exit === undefined) {
    throw new Error(
      harness.diagnosticText("Tinker and PTY wrapper exit within 2000ms"),
    );
  }
  expect(exit).toEqual({ code: 0, signal: null });
  expect(harness.wrapperExit()).toEqual({ code: 0, signal: null });
}

export async function storedSessions(
  workspaceRoot: string,
): Promise<readonly SessionSummary[]> {
  return new SessionCatalog({ workspaceRoot }).list();
}

export async function nonEmptySessions(
  workspaceRoot: string,
): Promise<readonly SessionSummary[]> {
  return (await storedSessions(workspaceRoot)).filter(
    (session) => session.turnCount > 0,
  );
}

export async function onlyNonEmptySession(
  workspaceRoot: string,
): Promise<SessionSummary> {
  const sessions = await nonEmptySessions(workspaceRoot);
  expect(sessions).toHaveLength(1);
  const session = sessions[0];
  if (session === undefined) {
    throw new Error("Expected one non-empty PTY session.");
  }
  return session;
}

export async function sessionSummary(
  workspaceRoot: string,
  sessionId: SessionId,
): Promise<SessionSummary> {
  return new SessionCatalog({ workspaceRoot }).get(sessionId);
}

export function currentSessionId(screen: string): SessionId {
  const value = screen.match(/\bsession=([0-9a-f-]{36})\b/u)?.[1];
  if (value === undefined) {
    throw new Error(`Current screen has no session ID:\n${screen}`);
  }
  return parseSessionId(value);
}

export function withSessionDatabase<T>(
  workspaceRoot: string,
  session: Pick<SessionSummary, "sessionId">,
  inspect: (database: Database) => T,
): T {
  const database = new Database(sessionDatabasePath(workspaceRoot, session.sessionId), {
    readonly: true,
    strict: true,
  });
  try {
    return inspect(database);
  } finally {
    database.close();
  }
}

export async function promptHistoryEntries(
  workspaceRoot: string,
): Promise<readonly string[]> {
  return (await PromptHistory.load(promptHistoryPath(workspaceRoot))).entries;
}

export async function waitForFileText(
  filePath: string,
  description: string,
  timeoutMs = 5_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`${description} was not ready within ${timeoutMs}ms.`);
    }
    await Bun.sleep(25);
  }
}

export function workspacePath(workspaceRoot: string, ...segments: string[]): string {
  return path.join(workspaceRoot, ...segments);
}
