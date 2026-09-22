import { SessionStore } from "../../session/session-store";
import { parseSessionId } from "../../ids/runtime-id";
const [workspaceRoot, homeRoot, id] = Bun.argv.slice(2);
const store = await SessionStore.openExisting({
  workspaceRoot,
  homeRoot,
  sessionId: parseSessionId(id),
});
const timer = setInterval(() => {}, 1000);
process.once("SIGTERM", () => {
  void store.abandon().finally(() => {
    clearInterval(timer);
    process.exit(0);
  });
});
console.log("LEASE_READY");
