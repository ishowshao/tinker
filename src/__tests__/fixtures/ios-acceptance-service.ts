/** Isolated HTTPS service for opt-in Simulator UI acceptance; no external model. */
import {
  appendFile,
  chmod,
  mkdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { createHash, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import path from "node:path";
import { createRemoteCertificates } from "../../../scripts/remote/certificates";
import { createRuntimeSession } from "../../agent/runtime-session";
import { parseSessionId } from "../../ids/runtime-id";
import { resolveSessionDatabasePath } from "../../session/session-store";
import { RemoteServiceStore } from "../../remote/service-store";
import { RemoteService } from "../../remote/service";
import { RemoteClient } from "../../remote/client";
import { startRemoteHttpServer } from "../../remote/http-server";
import type { OperationReceipt } from "../../remote/protocol";
import type {
  ModelRequestOptions,
  PreparedModelRequest,
} from "../../model/model-client";
import {
  TEST_CONTEXT_BUDGET,
  TEST_CONTEXT_PROFILE,
  TestModelClient,
  testModelOutput,
  testModelRequestInput,
} from "../test-runtime";
import { until } from "../helpers/remote-test-support";

const directory = Bun.argv[2];
if (!directory) throw new Error("Expected an empty temporary acceptance directory.");
await mkdir(directory, { recursive: true, mode: 0o700 });
const root = await realpath(directory);
// Exclusive sentinel prevents accidental reuse of an existing acceptance service.
await writeFile(path.join(root, "fixture-kind"), "isolated-ios-acceptance", {
  flag: "wx",
  mode: 0o600,
});
const workspace = path.join(root, "workspace");
await mkdir(workspace);
const certificates = path.join(root, "certificates");
await createRemoteCertificates(certificates, []);
const token = randomBytes(32).toString("base64url");
class AcceptanceModel extends TestModelClient {
  async request(prepared: PreparedModelRequest, options: ModelRequestOptions) {
    const messages = testModelRequestInput(prepared).messages;
    let index = messages.length - 1;
    while (index >= 0 && messages[index]?.role !== "user") index -= 1;
    const user = messages[index];
    if (user?.role !== "user") throw new Error("Missing acceptance prompt.");
    const prompt = user.content;
    const toolFinished = messages
      .slice(index + 1)
      .some((message) => message.role === "tool");
    const marker = prompt.match(/IOS_(?:BACKGROUND|RELAUNCH)_[A-Z0-9]+/)?.[0];
    const question = prompt.includes("AskUser");
    const stop = prompt.includes("sleep 60");
    await appendFile(
      path.join(root, "model-requests.jsonl"),
      JSON.stringify({
        turnId: options.identity?.iteration.turnId,
        prompt,
        toolFinished,
      }) + "\n",
    );
    if (toolFinished)
      return testModelOutput(prepared, {
        role: "assistant",
        content: marker ?? (question ? "IOS_QUESTION_DONE" : "DONE"),
      });
    if (!marker && !question && !stop)
      throw new Error("Unsupported Simulator acceptance prompt.");
    const identity = options.identity!;
    return testModelOutput(prepared, {
      role: "assistant",
      content: "Simulator acceptance tool running",
      toolCalls: [
        {
          ...identity.runtimeSession.createToolCall(identity.iteration, 1),
          providerToolCallId: `acceptance-${identity.iteration.turnId}`,
          name: question ? "AskUser" : "Bash",
          args: question
            ? {
                question: "Choose a scope",
                options: [
                  { description: "Current workspace" },
                  { description: "All workspaces" },
                ],
              }
            : { command: marker ? `sleep 12; printf '${marker}\\n'` : "sleep 60" },
        },
      ],
    });
  }
}
const store = await RemoteServiceStore.open(path.join(root, "service"));
const workspaces = [{ id: "workspace", name: "Simulator acceptance", path: workspace }];
const service = new RemoteService(
  store,
  workspaces,
  async ({ record, sink }) => {
    const sessionId = parseSessionId(record.id);
    const runtime = await createRuntimeSession(
      {
        workspaceRoot: workspace,
        homeRoot: root,
        ...(record.initialized
          ? { selection: { mode: "resume" as const, sessionId } }
          : { selection: { mode: "new" as const, sessionId } }),
        modelName: "simulator-acceptance",
        maxIterations: 10,
        includeReasoningContent: false,
        contextProfile: TEST_CONTEXT_PROFILE,
        contextBudget: TEST_CONTEXT_BUDGET,
        systemPrompt: "Isolated deterministic acceptance.",
        modelClient: new AcceptanceModel(),
        presentationSinks: [sink],
        assistantTextDeltaSink: sink,
        persistence: false,
        enableAskUser: true,
        bashGuard: { mode: "yolo", source: "cli", surface: "tui" },
      },
      { loadMcpConfig: async () => undefined },
    );
    return {
      runtime,
      databasePath: await resolveSessionDatabasePath(workspace, sessionId, root),
      modelName: "simulator-acceptance",
    };
  },
  root,
);
await service.initialize();
const server = startRemoteHttpServer(service, {
  stateDirectory: path.join(root, "service"),
  hostname: "127.0.0.1",
  port: 0,
  tls: {
    certFile: path.join(certificates, "app.crt"),
    keyFile: path.join(certificates, "app.key"),
  },
  devices: [
    {
      id: "simulator",
      name: "Simulator acceptance",
      tokenSha256: createHash("sha256").update(token).digest("hex"),
    },
  ],
  workspaces,
});
const url = `https://127.0.0.1:${server.port}`;
const transport = new RemoteClient(
  {
    url,
    token,
    ca: await Bun.file(path.join(certificates, "ca.crt")).text(),
    statePath: path.join(root, "client-state"),
  },
  false,
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await transport.close();
  await server.stopTransport();
  await service.close();
  process.exit(0);
}
process.on("SIGTERM", () => {
  void close();
});
process.on("SIGINT", () => {
  void close();
});
const created = await transport.request<OperationReceipt>("/v1/operations", {
  kind: "create",
  requestId: randomUUID(),
  workspaceId: "workspace",
});
await transport.request<OperationReceipt>("/v1/operations", {
  kind: "prompt",
  requestId: randomUUID(),
  sessionId: created.sessionId,
  prompt:
    "IOS_PROTOCOL_HANDOFF Call AskUser with question Choose a scope and options Current workspace and All workspaces. After the answer reply IOS_QUESTION_DONE.",
});
await until(() => service.session(created.sessionId).view().interaction);
const certificate = new X509Certificate(
  await Bun.file(path.join(certificates, "app.crt")).text(),
);
const pairing = {
  url,
  token,
  certificateSha256: createHash("sha256").update(certificate.raw).digest("hex"),
  acceptanceSessionId: created.sessionId,
};
const pairingPath = path.join(root, "pairing.json");
await Bun.write(`${pairingPath}.tmp`, JSON.stringify(pairing));
await chmod(`${pairingPath}.tmp`, 0o600);
await rename(`${pairingPath}.tmp`, pairingPath);
console.log(`Simulator acceptance ready: ${pairingPath}`);
