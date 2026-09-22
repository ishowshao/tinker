import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createRemoteCertificates } from "../../../scripts/remote/certificates";
import { RemoteClient } from "../../remote/client";
import type { OperationReceipt } from "../../remote/protocol";

export async function eventually<T>(
  read: () => Promise<T | undefined | false>,
  timeout = 10000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined && result !== false) return result;
    await Bun.sleep(20);
  }
  throw new Error("Recovery fixture timed out.");
}

export async function processFixture() {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "tinker-recovery-")),
  );
  await mkdir(path.join(root, "workspace"));
  await createRemoteCertificates(path.join(root, "certificates"), []);
  const token = randomBytes(32).toString("base64url");
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const spawn = (mode: string) => {
    const child = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "../fixtures/remote-recovery-process.ts"),
        mode,
        root,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    children.push(child);
    return child;
  };
  const start = async (port = 0) => {
    await rm(path.join(root, "server-ready"), { force: true });
    await Bun.write(path.join(root, "settings.json"), JSON.stringify({ token, port }));
    const child = spawn("server");
    await eventually(async () => {
      if (child.exitCode !== null)
        throw new Error(await new Response(child.stderr).text());
      return Bun.file(path.join(root, "server-ready")).exists();
    });
    const ready = (await Bun.file(path.join(root, "server-ready")).json()) as {
      port: number;
      epoch: string;
    };
    return { child, ...ready };
  };
  try {
    const server = await start();
    const config = {
      url: `https://127.0.0.1:${server.port}`,
      token,
      ca: await Bun.file(path.join(root, "certificates/ca.crt")).text(),
      statePath: path.join(root, "client.state"),
    };
    const transport = new RemoteClient(config, false);
    const create = await transport.request<OperationReceipt>("/v1/operations", {
      kind: "create",
      workspaceId: "test",
      requestId: randomUUID(),
    });
    const sessionId = create.sessionId;
    const operation = (prompt: string) => ({
      kind: "prompt" as const,
      sessionId,
      requestId: randomUUID(),
      prompt,
    });
    const submit = (input: ReturnType<typeof operation>) =>
      transport.request<OperationReceipt>("/v1/operations", input);
    const receipt = (id: string) =>
      transport.request<OperationReceipt>(`/v1/operations/${id}`);
    const terminal = (id: string) =>
      eventually(async () => {
        const current = await receipt(id);
        return current.status === "completed" && current;
      });
    return {
      root,
      server,
      config,
      transport,
      sessionId,
      operation,
      submit,
      receipt,
      terminal,
      start,
      spawn,
      cleanup: async () => {
        await transport.close();
        for (const child of children) {
          if (child.exitCode === null) child.kill("SIGKILL");
          await child.exited;
        }
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
