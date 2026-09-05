import { expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import type { WebSocketOptions } from "bun";
import { createRemoteCertificates } from "../../scripts/remote/certificates";
import { startRemoteHttpServer } from "../remote/http-server";
import type { RemoteFrame, OperationReceipt } from "../remote/protocol";
import { remoteFixture, RemoteTestModel, until } from "./helpers/remote-test-support";

test("HTTPS authentication and discarded receipts survive WebSocket and transport loss", async () => {
  const model = new RemoteTestModel();
  const fixture = await remoteFixture(model);
  const certificates = path.join(fixture.root, "certificates");
  await createRemoteCertificates(certificates, []);
  const token = randomBytes(32).toString("base64url");
  const config = {
    stateDirectory: path.join(fixture.root, "service"),
    hostname: "127.0.0.1",
    port: 0,
    tls: {
      certFile: path.join(certificates, "app.crt"),
      keyFile: path.join(certificates, "app.key"),
    },
    devices: [
      {
        id: "phone",
        name: "Phone",
        tokenSha256: createHash("sha256").update(token).digest("hex"),
      },
    ],
    workspaces: fixture.workspaces,
  };
  let transport = startRemoteHttpServer(fixture.service, config);
  const tls = { ca: await Bun.file(path.join(certificates, "ca.crt")).text() };
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const request = async (route: string, init: RequestInit = {}) => {
    const response = await fetch(`https://127.0.0.1:${transport.port}${route}`, {
      ...init,
      tls,
      keepalive: false,
    });
    return new Response(await response.arrayBuffer(), { status: response.status });
  };
  const frames: RemoteFrame[] = [];
  const Socket = WebSocket as unknown as {
    new (url: string, options: WebSocketOptions): WebSocket;
  };
  let socket: WebSocket | undefined;
  try {
    expect((await request("/v1/workspaces")).status).toBe(401);
    expect(
      (
        await request("/v1/workspaces", {
          headers: { ...headers, origin: "https://example.com" },
        })
      ).status,
    ).toBe(403);
    expect((await request("/v1/workspaces", { headers })).status).toBe(200);
    socket = new Socket(
      `wss://127.0.0.1:${transport.port}/v1/sessions/${fixture.sessionId}/events`,
      { headers, tls },
    );
    socket.onmessage = (event) =>
      frames.push(JSON.parse(String(event.data)) as RemoteFrame);
    await until(() => frames.some((frame) => frame.type === "snapshot"));
    const input = {
      kind: "prompt",
      requestId: randomUUID(),
      sessionId: fixture.sessionId,
      prompt: "one accepted request",
    };
    const init = { method: "POST", headers, body: JSON.stringify(input) };
    const discarded = await request("/v1/operations", init);
    expect(discarded.status).toBe(202);
    await discarded.body?.cancel();
    await until(() => model.requests === 1);
    socket.close();
    await until(() => socket?.readyState === WebSocket.CLOSED);
    await transport.stopTransport();
    expect(model.aborted).toBe(false);
    model.release();
    await until(() => fixture.store.get(input.requestId).status === "completed");
    transport = startRemoteHttpServer(fixture.service, config);
    const retried = await request("/v1/operations", init);
    const receipt = (await retried.json()) as OperationReceipt;
    expect(receipt.status).toBe("completed");
    expect(model.requests).toBe(1);
    const snapshot = await request(`/v1/sessions/${fixture.sessionId}/snapshot`, {
      headers,
    });
    const body = await snapshot.text();
    expect(body).toContain("Complete answer 1");
    expect(
      fixture.service
        .session(fixture.sessionId)
        .history()
        .messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
  } finally {
    socket?.close();
    await transport.stopTransport();
    await fixture.cleanup();
  }
}, 15000);
