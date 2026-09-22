import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { createRemoteCertificates } from "../../../scripts/remote/certificates";
import { startRemoteHttpServer } from "../../remote/http-server";
import type {
  ModelClient,
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedModelRequest,
} from "../../model/model-client";
import {
  TestModelClient,
  testModelOutput,
  testModelRequestInput,
} from "../test-runtime";
import { remoteFixture } from "./remote-test-support";

export async function remoteTuiFixture(
  model: ModelClient,
  catalog?: import("../../client/model-catalog").ClientModelCatalog,
) {
  const f = await remoteFixture(model, catalog);
  const certificates = path.join(f.root, "certificates");
  await createRemoteCertificates(certificates, []);
  const token = randomBytes(32).toString("base64url");
  const config = {
    stateDirectory: path.join(f.root, "service"),
    hostname: "127.0.0.1",
    port: 0,
    tls: {
      certFile: path.join(certificates, "app.crt"),
      keyFile: path.join(certificates, "app.key"),
    },
    devices: [
      {
        id: "terminal",
        name: "Terminal",
        tokenSha256: createHash("sha256").update(token).digest("hex"),
      },
    ],
    workspaces: f.workspaces,
  };
  let server = startRemoteHttpServer(f.service, config);
  const clientConfig = {
    url: `https://127.0.0.1:${server.port}`,
    token,
    ca: await Bun.file(path.join(certificates, "ca.crt")).text(),
    statePath: path.join(f.root, "client.state.json"),
  };
  const configPath = path.join(f.root, "client.json");
  await Bun.write(
    configPath,
    JSON.stringify({
      url: clientConfig.url,
      token,
      caFile: path.join(certificates, "ca.crt"),
    }),
  );
  return {
    ...f,
    clientConfig,
    configPath,
    disconnect: () => server.stopTransport(),
    reconnect: () => {
      server = startRemoteHttpServer(f.service, { ...config, port: server.port });
    },
    cleanup: async () => {
      await server.stopTransport();
      await f.cleanup();
    },
  };
}

/** Gate every model request so tests observe streaming, steering and explicit cancellation. */
export class RemoteExecutionModel extends TestModelClient {
  readonly calls: { input: string; release: () => void }[] = [];
  aborted = false;
  constructor(private readonly useTool = true) {
    super();
  }
  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    const number = this.calls.length + 1;
    const text = `# REMOTE_STREAM_${number}\n\nstreamed section ${number}\n\n# Tail\n\nREMOTE_DONE_${number}`;
    options.onTextDelta?.(text);
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        this.aborted = true;
        reject(
          options.signal.reason instanceof Error
            ? options.signal.reason
            : new Error("Model aborted."),
        );
      };
      options.signal.addEventListener("abort", abort, { once: true });
      this.calls.push({
        input: JSON.stringify(testModelRequestInput(prepared).messages),
        release: () => {
          options.signal.removeEventListener("abort", abort);
          resolve();
        },
      });
      if (options.signal.aborted) abort();
    });
    const identity = options.identity!;
    return testModelOutput(prepared, {
      role: "assistant",
      content: text,
      ...(this.useTool && number === 1
        ? {
            toolCalls: [
              {
                ...identity.runtimeSession.createToolCall(identity.iteration, 1),
                providerToolCallId: "remote-execution-tool",
                name: "Bash",
                args: { command: "sleep 1; printf REMOTE_TOOL_DONE" },
              },
            ],
          }
        : {}),
    });
  }
}
