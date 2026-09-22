import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { createRemoteCertificates } from "../../scripts/remote/certificates";
import { startRemoteHttpServer } from "../remote/http-server";
import { createRemoteTuiClient } from "../client/remote-workspace-client";
import { RemoteTuiView } from "../client/remote-tui-view";
import { parseSessionId } from "../ids/runtime-id";
import { isSessionSelectable } from "../tui/components/resume-session-picker";
import { RemoteTestModel, remoteFixture, until } from "./helpers/remote-test-support";

test("full TUI clients connect, retain canonical history and detach independently over HTTPS", async () => {
  const model = new RemoteTestModel();
  const f = await remoteFixture(model);
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
    statePath: path.join(f.root, "must-not-be-written.json"),
  };
  let first;
  let second;
  try {
    const recoveredView = new RemoteTuiView(
      f.service.session(f.sessionId).tuiSnapshot(),
    );
    recoveredView.setConnection("online", "Temporary snapshot failure");
    expect(recoveredView.getServiceStatus().error).toBe("Temporary snapshot failure");
    expect(recoveredView.getLogSnapshot().live).toHaveLength(0);
    recoveredView.update(f.service.session(f.sessionId).tuiSnapshot());
    expect(recoveredView.getServiceStatus()).toEqual({
      connection: "online",
      activity: "idle",
      error: undefined,
    });
    expect(recoveredView.getLogSnapshot().live).toHaveLength(0);
    first = await createRemoteTuiClient(clientConfig, "test", f.sessionId);
    second = await createRemoteTuiClient(clientConfig, "test", f.sessionId);
    expect(f.factoryCalls()).toBe(1);
    const firstView = first.client.getBinding().projectionStore;
    const secondView = second.client.getBinding().projectionStore;
    const receipt = await f.prompt();
    await until(() => model.requests === 1);
    await until(() => secondView.getSnapshot().status === "running");
    expect(secondView.getSnapshot().recentTurns).toHaveLength(0);
    expect(secondView.getSnapshot().activeTurn).toBeDefined();
    // A different terminal can create another session without stopping this task.
    await first.client.clear();
    expect(first.client.getBinding().sessionId).not.toBe(f.sessionId);
    const active = (await first.client.listSessions()).find(
      (s) => s.sessionId === f.sessionId,
    )!;
    expect(active.status).toBe("active");
    expect(isSessionSelectable(active)).toBe(true);
    await first.client.resume(parseSessionId(f.sessionId));
    expect(f.factoryCalls()).toBe(2);
    expect(first.client.getBinding().projectionStore).not.toBe(firstView);
    await first.close({ type: "client_exit" });
    first = undefined;
    expect(model.aborted).toBe(false);
    model.release();
    await f.terminal(receipt);
    await until(() => secondView.getSnapshot().recentTurns.length === 1);
    expect(
      secondView
        .getSnapshot()
        .recentTurns[0].items.some((item) => item.text.includes("Complete answer 1")),
    ).toBe(true);
    const ids = secondView.getLogSnapshot().committed.map((item) => item.id);
    const port = server.port;
    await server.stopTransport();
    await until(() => secondView.getServiceStatus?.().connection === "offline");
    server = startRemoteHttpServer(f.service, { ...config, port });
    await until(() => secondView.getServiceStatus?.().connection === "online");
    expect(secondView.getLogSnapshot().committed.map((item) => item.id)).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(await Bun.file(clientConfig.statePath).exists()).toBe(false);
    const before = second.client.getBinding();
    const failed = await second.client
      .resume(parseSessionId("00000000-0000-7000-8000-000000000001"))
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toContain("does not belong");
    expect(second.client.getBinding()).toBe(before);
    const result = await second.client
      .getBinding()
      .executeTurn(
        { role: "user", content: "another task" },
        new AbortController().signal,
      );
    expect(result.status).toBe("completed");
    expect(model.requests).toBe(2);
  } finally {
    await first?.close({ type: "client_exit" });
    await second?.close({ type: "client_exit" });
    await server.stopTransport();
    await f.cleanup();
  }
}, 20000);
