import { appendFile, rename } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRuntimeSession } from "../../agent/runtime-session";
import { parseSessionId } from "../../ids/runtime-id";
import { resolveSessionDatabasePath } from "../../session/session-store";
import { RemoteServiceStore } from "../../remote/service-store";
import { RemoteService } from "../../remote/service";
import { startRemoteHttpServer } from "../../remote/http-server";
import { createRemoteTuiClient } from "../../client/remote-workspace-client";
import type { RemoteClientConfig } from "../../remote/client";
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

const [mode, root] = Bun.argv.slice(2);
if (!root) throw new Error("Expected isolated recovery fixture root.");
async function publish(name: string, content: string) {
  const filename = path.join(root, name);
  await Bun.write(`${filename}.tmp`, content);
  await rename(`${filename}.tmp`, filename);
}
const settings = (await Bun.file(path.join(root, "settings.json")).json()) as {
  token: string;
  port: number;
};
if (mode === "client") {
  const config = (await Bun.file(
    path.join(root, "client.json"),
  ).json()) as RemoteClientConfig & { sessionId: string };
  const client = await createRemoteTuiClient(config, "test", config.sessionId);
  const accepted = await client.client.getBinding().admitTurn!(
    { role: "user", content: "EFFECT" },
    new AbortController().signal,
  );
  void accepted.completion.catch(() => {});
  await publish("client-ready", "accepted");
  await new Promise<never>(() => undefined);
} else {
  class RecoveryModel extends TestModelClient {
    async request(prepared: PreparedModelRequest, options: ModelRequestOptions) {
      const messages = testModelRequestInput(prepared).messages;
      await appendFile(path.join(root, "requests"), "request\n");
      const text = JSON.stringify(messages);
      if (!text.includes("EFFECT"))
        return testModelOutput(prepared, {
          role: "assistant",
          content: "BASELINE_DONE",
        });
      if (!text.includes("EFFECT_WRITTEN")) {
        const identity = options.identity!;
        return testModelOutput(prepared, {
          role: "assistant",
          content: "Writing effect",
          toolCalls: [
            {
              ...identity.runtimeSession.createToolCall(identity.iteration, 1),
              providerToolCallId: "effect",
              name: "Bash",
              args: {
                command: "printf 'effect\\n' >> effect.txt; printf EFFECT_WRITTEN",
              },
            },
          ],
        });
      }
      options.onTextDelta?.("PROVISIONAL_RECOVERY_TEXT");
      await publish("effect-ready", "waiting");
      while (!(await Bun.file(path.join(root, "release")).exists())) {
        if (options.signal.aborted) throw new Error("aborted");
        await Bun.sleep(10);
      }
      return testModelOutput(prepared, {
        role: "assistant",
        content: "EFFECT_DONE",
      });
    }
  }
  const workspace = path.join(root, "workspace");
  const store = await RemoteServiceStore.open(path.join(root, "service"));
  const workspaces = [{ id: "test", name: "Recovery", path: workspace }];
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
          modelName: "recovery-model",
          maxIterations: 10,
          includeReasoningContent: false,
          contextProfile: TEST_CONTEXT_PROFILE,
          contextBudget: TEST_CONTEXT_BUDGET,
          systemPrompt: "system",
          modelClient: new RecoveryModel(),
          presentationSinks: [sink],
          assistantTextDeltaSink: sink,
          persistence: false,
          bashGuard: { mode: "yolo", source: "cli", surface: "tui" },
        },
        { loadMcpConfig: async () => undefined },
      );
      return {
        runtime,
        databasePath: await resolveSessionDatabasePath(workspace, sessionId, root),
        modelName: "recovery-model",
      };
    },
    root,
  );
  await service.initialize();
  const server = startRemoteHttpServer(service, {
    stateDirectory: path.join(root, "service"),
    hostname: "127.0.0.1",
    port: settings.port,
    tls: {
      certFile: path.join(root, "certificates/app.crt"),
      keyFile: path.join(root, "certificates/app.key"),
    },
    devices: [
      {
        id: "terminal",
        name: "Terminal",
        tokenSha256: createHash("sha256").update(settings.token).digest("hex"),
      },
    ],
    workspaces,
  });
  await publish(
    "server-ready",
    JSON.stringify({ port: server.port, epoch: service.epoch }),
  );
}
