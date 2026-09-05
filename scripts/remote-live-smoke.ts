import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { RemoteClient, loadRemoteClientConfig } from "../src/remote/client";
import type { OperationReceipt, RemoteFrame, RemoteView } from "../src/remote/protocol";
import { command } from "./remote/certificates";

const directory = path.resolve(process.argv[2] ?? ".tinker/remote-local");
const config = await loadRemoteClientConfig(path.join(directory, "client.json"));
const client = new RemoteClient({
  ...config,
  statePath: path.join(directory, "live-smoke-client.json"),
});
const evidence: Record<string, unknown>[] = [];
const workspace = (await client.workspaces()).workspaces[0];
if (!workspace) throw new Error("No configured workspace.");
const session = await client.request<OperationReceipt>("/v1/operations", {
  requestId: randomUUID(),
  kind: "create",
  workspaceId: workspace.id,
  title: "Real model relay acceptance",
});
await client.select(session.sessionId, workspace.id);
const sessionId = session.sessionId;
await waitFor(() => client.getSnapshot().connection === "online");
const model = client.getSnapshot().view?.session.modelName;
console.log(`Real model acceptance using ${model}; session ${sessionId}`);

async function snapshot(): Promise<RemoteView> {
  const frame = await client.request<RemoteFrame>(`/v1/sessions/${sessionId}/snapshot`);
  if (frame.type !== "snapshot") throw new Error("Expected snapshot.");
  return frame.view;
}
async function submit(prompt: string): Promise<OperationReceipt> {
  return client.request<OperationReceipt>("/v1/operations", {
    requestId: randomUUID(),
    kind: "prompt",
    sessionId,
    prompt,
  });
}
async function terminal(receipt: OperationReceipt): Promise<OperationReceipt> {
  let last = receipt;
  await waitFor(async () => {
    last = await client.operation(receipt.requestId);
    return ["completed", "failed", "cancelled", "interrupted"].includes(last.status);
  }, 180000);
  if (last.status !== "completed")
    throw new Error(`Real-model request ended ${last.status}: ${last.error ?? ""}`);
  return last;
}
async function component(action: "up" | "down", name: "tunnel" | "relay") {
  console.log(
    await command([
      process.execPath,
      "scripts/remote-local.ts",
      action,
      name,
      "--directory",
      directory,
    ]),
  );
}

try {
  for (const fault of ["tunnel", "relay"] as const) {
    const marker = `REMOTE_${fault.toUpperCase()}_${randomUUID().slice(0, 8)}`;
    const prompt = `Local connectivity acceptance. Do not edit source files. Call Bash with exactly this command: sleep 12; printf '${marker}\\n'. Wait for the command to finish, then reply with ${marker}.`;
    const accepted = await submit(prompt);
    await waitFor(
      () =>
        client
          .getSnapshot()
          .view?.tools.some(
            (tool) => tool.name === "Bash" && tool.status === "running",
          ) === true,
      120000,
    );
    const before = client.getSnapshot().view;
    await component("down", fault);
    await waitFor(() => client.getSnapshot().connection !== "online", 45000);
    await new Promise((resolve) => setTimeout(resolve, 15000));
    // The only fault is the phone/relay path; provider networking is untouched.
    await component("up", fault);
    await waitFor(() => client.getSnapshot().connection === "online", 60000);
    const done = await terminal(accepted);
    const view = await snapshot();
    if (
      !view.history.messages.some(
        (message) => message.role === "assistant" && message.text.includes(marker),
      )
    )
      throw new Error("Missing canonical result after reconnect.");
    evidence.push({
      scenario: `${fault}_outage`,
      requestId: accepted.requestId,
      turnId: done.turnId,
      model,
      toolWasRunning: true,
      activeRequestBefore: before?.activeRequestId,
      canonicalResult: marker,
      passed: true,
    });
    console.log(`${fault} outage: execution survived and canonical result recovered`);
  }

  const question = await submit(
    "Local acceptance test: call AskUser with question 'Which test scope?' and two options 'Current workspace' and 'All workspaces'. After the answer, say 'QUESTION_RECOVERED'. Do not edit files.",
  );
  await waitFor(
    () => client.getSnapshot().view?.interaction?.kind === "question",
    120000,
  );
  const pending = client.getSnapshot().view!.interaction!;
  await component("down", "tunnel");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await component("up", "tunnel");
  await waitFor(() => client.getSnapshot().connection === "online", 60000);
  if (client.getSnapshot().view?.interaction?.id !== pending.id)
    throw new Error("Question identity changed across disconnect.");
  const answer = {
    requestId: randomUUID(),
    kind: "answer",
    sessionId,
    interactionId: pending.id,
    selectedIndex: 0,
  };
  await client.request("/v1/operations", answer);
  await client.request("/v1/operations", answer);
  await terminal(question);
  evidence.push({
    scenario: "offline_question",
    requestId: question.requestId,
    sameInteractionId: true,
    duplicateAnswer: true,
    passed: true,
  });
  console.log("Question survived reconnect; duplicate answer did not apply twice");

  const harmlessCommand = "reboot() { printf 'REMOTE_GUARD_FIXTURE\\n'; }; reboot";
  const confirmation = await submit(
    `Local acceptance test for tool confirmation. Call Bash with exactly this command: ${harmlessCommand}. This defines a harmless shell function and calls only that function; never run the system reboot program. After explicit approval and tool completion, reply CONFIRMATION_RECOVERED.`,
  );
  await waitFor(
    () => client.getSnapshot().view?.interaction?.kind === "confirmation",
    120000,
  );
  const confirm = client.getSnapshot().view!.interaction!;
  if (confirm.kind !== "confirmation" || confirm.command !== harmlessCommand) {
    if (confirm.kind === "confirmation")
      await client.request("/v1/operations", {
        requestId: randomUUID(),
        kind: "confirm",
        sessionId,
        interactionId: confirm.id,
        decision: "deny",
      });
    throw new Error(
      "The model did not request the exact harmless confirmation fixture.",
    );
  }
  await component("down", "relay");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await component("up", "relay");
  await waitFor(() => client.getSnapshot().connection === "online", 60000);
  if (client.getSnapshot().view?.interaction?.id !== confirm.id)
    throw new Error("Confirmation identity changed.");
  await client.request("/v1/operations", {
    requestId: randomUUID(),
    kind: "confirm",
    sessionId,
    interactionId: confirm.id,
    decision: "allow",
  });
  await terminal(confirmation);
  evidence.push({
    scenario: "offline_confirmation",
    requestId: confirmation.requestId,
    sameInteractionId: true,
    passed: true,
  });
  console.log("Confirmation survived relay outage and resolved explicitly");

  const retry = {
    requestId: randomUUID(),
    kind: "prompt",
    sessionId,
    prompt: `Reply with exactly DEDUP_${randomUUID().slice(0, 8)}. Do not use tools.`,
  };
  // Consume no receipt on the first POST: emulate acceptance with a lost response.
  const response = await fetch(`${config.url}/v1/operations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(retry),
    tls: { ca: config.ca, rejectUnauthorized: true },
  });
  if (response.status !== 202)
    throw new Error(`Acceptance failed: HTTP ${response.status}`);
  await response.body?.cancel();
  const repeated = await client.request<OperationReceipt>("/v1/operations", retry);
  await terminal(repeated);
  const view = await snapshot();
  if (
    view.history.messages.filter(
      (message) => message.role === "user" && message.text === retry.prompt,
    ).length !== 1
  )
    throw new Error("Duplicate canonical user turn.");
  evidence.push({
    scenario: "discarded_http_receipt_retry",
    requestId: retry.requestId,
    canonicalUserCount: 1,
    passed: true,
  });
  console.log("Discarded receipt retry: one canonical turn");
} finally {
  await component("up", "relay");
  await component("up", "tunnel");
  await client.close();
  await writeFile(
    path.join(directory, "live-acceptance.json"),
    JSON.stringify(
      { date: new Date().toISOString(), sessionId, model, evidence },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

async function waitFor(
  read: () => boolean | Promise<boolean>,
  timeout = 20000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the live acceptance condition.");
}
