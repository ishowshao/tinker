import { writeFile } from "node:fs/promises";
import type { SessionId } from "../../ids/runtime-id";
import { SessionLease } from "../../session/session-lock";

const [sessionDirectory, sessionIdValue, markerPath] = Bun.argv.slice(2);
if (
  sessionDirectory === undefined ||
  sessionIdValue === undefined ||
  markerPath === undefined
) {
  throw new Error("Expected session directory, session ID, and marker path.");
}

await SessionLease.acquire({
  sessionDirectory,
  sessionId: sessionIdValue as SessionId,
});
await writeFile(markerPath, "ready\n", "utf8");
await new Promise<never>(() => undefined);
