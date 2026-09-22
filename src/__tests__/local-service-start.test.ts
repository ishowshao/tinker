import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { createRemoteCertificates } from "../../scripts/remote/certificates";
import { ensureLocalService } from "../cli/local-service-start";
import { resolveConnectedWorkspace } from "../cli/connect-workspace";
import { RemoteClient } from "../remote/client";
import { registerLocalWorkspace } from "../remote/local-service-discovery";
import { createHostedRuntimeFactory } from "../cli/serve-runtime";
import type { ManagedSessionRecord } from "../remote/service-store";
import { createUuidV7 } from "../ids/uuid-v7";
import { SessionCatalog } from "../session/session-catalog";
import { RemoteServiceStore } from "../remote/service-store";
import { SessionLease } from "../session/session-lock";
import { parseSessionId } from "../ids/runtime-id";
import {
  defaultServiceConfigPath,
  discoverLocalService,
  loadLocalServiceTarget,
  localServicePaths,
  type LocalServiceInstance,
} from "../remote/local-service-discovery";

async function waitFor<T>(
  read: () => Promise<T | undefined | false>,
  timeout = 5000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    await Bun.sleep(25);
  }
  throw new Error("Local service test timed out.");
}

async function fixture() {
  const root = await realpath(await mkdtemp("/tmp/tinker-local-"));
  const env = { ...process.env, TINKER_HOME: root };
  const configPath = defaultServiceConfigPath(env);
  await mkdir(path.dirname(configPath), { recursive: true });
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const certs = path.join(root, "certs");
  await createRemoteCertificates(certs, []);
  const token = randomBytes(32).toString("base64url");
  const config = {
    version: 1,
    hostname: "127.0.0.1",
    port: 0,
    tls: {
      certFile: path.join(certs, "app.crt"),
      keyFile: path.join(certs, "app.key"),
    },
    devices: [
      {
        id: "test",
        name: "Test",
        tokenSha256: createHash("sha256").update(token).digest("hex"),
      },
    ],
    workspaces: [{ id: "test", name: "Test", path: workspace }],
  };
  await Bun.write(configPath, JSON.stringify(config));
  const target = await loadLocalServiceTarget(configPath, env);
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const owned = new Set<number>();
  const startProcess = (args: string[], cwd = root) => {
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "../cli/index.ts"), ...args],
      {
        env,
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    children.push(child);
    return child;
  };
  const cli = async (args: string[], cwd = root) => {
    const child = startProcess(args, cwd);
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code === 0 && args.includes("--background"))
      owned.add((JSON.parse(stdout) as LocalServiceInstance).pid);
    return { code, stdout, stderr };
  };
  const kill = async (pid: number, signal: NodeJS.Signals = "SIGTERM") => {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await waitFor(async () => !(await discoverLocalService(target)));
    // A listener closes before the canonical lease is released during graceful shutdown.
    if (signal === "SIGTERM")
      await waitFor(
        async () =>
          !(await Bun.file(
            path.join(target.config.stateDirectory, "active.lock"),
          ).exists()),
      );
    owned.delete(pid);
  };
  return {
    root,
    env,
    configPath,
    config,
    workspace,
    target,
    token,
    certs,
    cli,
    startProcess,
    owned,
    kill,
    cleanup: async () => {
      for (const child of children) {
        if (child.exitCode === null) child.kill("SIGTERM");
        await child.exited;
      }
      const running = await discoverLocalService(target).catch(() => undefined);
      if (running) owned.add(running.pid);
      for (const pid of owned)
        await kill(pid).catch(() => {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* The isolated child may already have exited. */
          }
        });
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("local startup: six independent CLI processes discover one detached service across working directories", async () => {
  const f = await fixture();
  try {
    expect((await f.cli(["serve", "--status"])).code).toBe(1);
    expect(
      await Bun.file(
        path.join(f.target.config.stateDirectory, "remote.sqlite"),
      ).exists(),
    ).toBe(false);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        f.cli(["serve", "--background"], i % 2 ? f.workspace : f.root),
      ),
    );
    for (const result of results) {
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
    }
    const instances = results.map(
      (result) => JSON.parse(result.stdout) as LocalServiceInstance,
    );
    expect(new Set(instances.map((i) => i.pid)).size).toBe(1);
    expect(new Set(instances.map((i) => i.instanceId)).size).toBe(1);
    const instance = instances[0];
    expect(instance.url).not.toEndWith(":0");
    expect(instance.configPath).toBe(f.configPath);
    expect(instance.stateDirectory).toBe(
      path.join(path.dirname(f.configPath), "state"),
    );
    const live = await f.cli(["serve", "--status"], f.workspace);
    expect(JSON.parse(live.stdout)).toMatchObject({
      pid: instance.pid,
      status: "online",
    });
    const response = await fetch(`${instance.url}/v1/workspaces`, {
      headers: { Authorization: `Bearer ${f.token}` },
      tls: { ca: await readFile(path.join(f.certs, "ca.crt"), "utf8") },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workspaces: [{ id: "test" }] });
    const files = localServicePaths(f.target.config.stateDirectory);
    expect((await stat(files.instance)).mode & 0o777).toBe(0o600);
    expect((await stat(files.log)).mode & 0o777).toBe(0o600);
    expect((await stat(f.target.config.stateDirectory)).mode & 0o777).toBe(0o700);
    expect(await Bun.file(path.join(files.startup, "active.lock")).exists()).toBe(
      false,
    );
    expect(await readFile(files.instance, "utf8")).not.toContain(f.token);
    const duplicate = await f.cli(["serve"]);
    expect(duplicate.code).toBe(1);
    expect((await discoverLocalService(f.target))?.pid).toBe(instance.pid);
    await f.kill(instance.pid);
    expect(await Bun.file(files.instance).exists()).toBe(false);
    expect((await f.cli(["serve", "--status"])).code).toBe(1);
  } finally {
    await f.cleanup();
  }
}, 20000);

test("local discovery reuses foreground servers and rejects configuration changes", async () => {
  const f = await fixture();
  try {
    const foreground = f.startProcess(["serve", "--config", f.configPath]);
    const instance = await waitFor(() => discoverLocalService(f.target));
    expect(instance.pid).toBe(foreground.pid);
    expect((await ensureLocalService(f.target, f.env)).pid).toBe(foreground.pid);
    expect(
      await Bun.file(localServicePaths(f.target.config.stateDirectory).log).exists(),
    ).toBe(false);
    await Bun.write(
      f.configPath,
      JSON.stringify({
        ...f.config,
        workspaces: [{ ...f.config.workspaces[0], name: "Changed" }],
      }),
    );
    const changed = await f.cli(["serve", "--background"]);
    expect(changed.code).toBe(1);
    expect(changed.stderr).toContain("different configuration");
    expect((await discoverLocalService(f.target))?.pid).toBe(instance.pid);
    foreground.kill("SIGTERM");
    expect(await foreground.exited).toBe(0);
  } finally {
    await f.cleanup();
  }
}, 15000);

test("local startup reclaims a killed service without trusting stale instance files", async () => {
  const f = await fixture();
  try {
    const first = JSON.parse(
      (await f.cli(["serve", "--background"])).stdout,
    ) as LocalServiceInstance;
    await f.kill(first.pid, "SIGKILL");
    expect(
      await Bun.file(
        localServicePaths(f.target.config.stateDirectory).instance,
      ).exists(),
    ).toBe(true);
    expect((await f.cli(["serve", "--status"])).code).toBe(1);
    const next = await Promise.all([
      f.cli(["serve", "--background"]),
      f.cli(["serve", "--background"]),
    ]);
    expect(next.map((r) => r.code)).toEqual([0, 0]);
    const second = JSON.parse(next[0].stdout) as LocalServiceInstance;
    expect(second.instanceId).not.toBe(first.instanceId);
    expect((JSON.parse(next[1].stdout) as LocalServiceInstance).pid).toBe(second.pid);
  } finally {
    await f.cleanup();
  }
}, 15000);

test("local startup recovers a startup lease left by a dead launcher", async () => {
  const f = await fixture();
  const exited = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await exited.exited;
  const directory = localServicePaths(f.target.config.stateDirectory).startup;
  try {
    await mkdir(directory, { recursive: true });
    await SessionLease.acquire({
      sessionDirectory: directory,
      sessionId: parseSessionId("00000000-0000-7000-8000-000000000002"),
      dependencies: { pid: exited.pid },
    });
    const result = await f.cli(["serve", "--background"]);
    expect(result.code).toBe(0);
    expect(await Bun.file(path.join(directory, "active.lock")).exists()).toBe(false);
  } finally {
    await f.cleanup();
  }
}, 10000);

test("local startup leaves a live unresponsive owner alone and bounds corrupt startup-lock waits", async () => {
  const f = await fixture();
  const store = await RemoteServiceStore.open(f.target.config.stateDirectory);
  try {
    const error = await ensureLocalService(f.target, f.env, 250).catch(
      (e: unknown) => e,
    );
    expect(String(error)).toContain("not ready");
    expect(
      await Bun.file(localServicePaths(f.target.config.stateDirectory).log).exists(),
    ).toBe(false);
    await Bun.write(
      path.join(
        localServicePaths(f.target.config.stateDirectory).startup,
        "active.lock",
      ),
      "incomplete",
    );
    const corrupt = await ensureLocalService(f.target, f.env, 200).catch(
      (e: unknown) => e,
    );
    expect(String(corrupt)).toContain("startup ownership");
  } finally {
    await store.close();
    await f.cleanup();
  }
}, 5000);

test("local startup reports occupied ports without reusing unrelated services, and canonicalizes state aliases", async () => {
  const f = await fixture();
  const occupied = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("unrelated"),
  });
  try {
    await Bun.write(f.configPath, JSON.stringify({ ...f.config, port: occupied.port }));
    const result = await f.cli(["serve", "--background"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("exited before becoming ready");
    expect(
      await Bun.file(path.join(f.target.config.stateDirectory, "active.lock")).exists(),
    ).toBe(false);
    const alias = path.join(f.root, "alias");
    await symlink(f.target.config.stateDirectory, alias);
    await Bun.write(
      f.configPath,
      JSON.stringify({ ...f.config, stateDirectory: alias }),
    );
    const target = await loadLocalServiceTarget(f.configPath, f.env);
    expect(target.config.stateDirectory).toBe(f.target.config.stateDirectory);
    const result2 = await f.cli(["serve", "--background"]);
    expect(result2.code).toBe(0);
  } finally {
    await occupied.stop(true);
    await f.cleanup();
  }
}, 15000);

test("local workspace registration is canonical, concurrent, persistent and unavailable to remote-only clients", async () => {
  const f = await fixture();
  let remote: RemoteClient | undefined;
  try {
    const started = JSON.parse(
      (await f.cli(["serve", "--background"])).stdout,
    ) as LocalServiceInstance;
    const config = {
      url: started.url,
      token: f.token,
      ca: await readFile(path.join(f.certs, "ca.crt"), "utf8"),
      statePath: path.join(f.root, "client-state"),
    };
    remote = new RemoteClient(config, false);
    const child = path.join(f.workspace, "src");
    await mkdir(child);
    expect((await remote.resolveWorkspace(child)).id).toBe("test");
    const unknown = path.join(f.root, "another");
    await mkdir(unknown);
    const alias = path.join(f.root, "alias");
    await symlink(unknown, alias);
    expect(
      String(await remote.resolveWorkspace(unknown).catch((e: unknown) => e)),
    ).toContain("outside configured");
    expect(
      String(
        await remote
          .request("/v1/workspaces/register", { directory: unknown })
          .catch((e: unknown) => e),
      ),
    ).toContain("Unknown");
    const ids = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        resolveConnectedWorkspace({
          config,
          cwd: index % 2 ? alias : unknown,
          env: f.env,
          serviceConfigPath: f.configPath,
        }),
      ),
    );
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toStartWith("local-");
    expect((await remote.workspaces()).workspaces).toHaveLength(2);
    expect(await remote.resolveWorkspace(alias)).toMatchObject({
      id: ids[0],
      path: unknown,
    });
    expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual(f.config);
    const nested = path.join(unknown, "nested");
    await mkdir(nested);
    expect((await registerLocalWorkspace(f.target, nested)).id).toBe(ids[0]);
    await f.kill(started.pid);
    const next = JSON.parse(
      (await f.cli(["serve", "--background"])).stdout,
    ) as LocalServiceInstance;
    await remote.close();
    remote = new RemoteClient({ ...config, url: next.url }, false);
    expect((await remote.resolveWorkspace(unknown)).id).toBe(ids[0]);
    expect((await remote.workspaces()).workspaces).toHaveLength(2);
    // The public config does not widen; durable local registrations are merged on boot.
    expect(f.target.config.workspaces).toHaveLength(1);
  } finally {
    await remote?.close();
    await f.cleanup();
  }
}, 20000);

test("local registration verifies the paired service identity before publishing a workspace", async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    const started = JSON.parse(
      (await other.cli(["serve", "--background"])).stdout,
    ) as LocalServiceInstance;
    const config = {
      url: started.url,
      token: other.token,
      ca: await readFile(path.join(other.certs, "ca.crt"), "utf8"),
      statePath: path.join(f.root, "client-state"),
    };
    const unknown = path.join(f.root, "unregistered");
    await mkdir(unknown);
    const error = await resolveConnectedWorkspace({
      config,
      cwd: unknown,
      env: f.env,
      serviceConfigPath: f.configPath,
    }).catch((e: unknown) => e);
    expect(String(error)).toContain("different service");
    // Discovery-only status is sufficient to locate and clean up the local starter's child.
    const local = await discoverLocalService(f.target);
    expect(local).toBeDefined();
    const probe = new RemoteClient(
      {
        ...config,
        url: local!.url,
        token: f.token,
        ca: await readFile(path.join(f.certs, "ca.crt"), "utf8"),
      },
      false,
    );
    try {
      expect((await probe.workspaces()).workspaces).toHaveLength(1);
    } finally {
      await probe.close();
    }
  } finally {
    await f.cleanup();
    await other.cleanup();
  }
}, 15000);

test("hosted runtime composition sees newly registered workspace entries", async () => {
  const f = await fixture();
  const entries = [...f.target.config.workspaces];
  const factory = createHostedRuntimeFactory(
    () => entries,
    {
      TINKER_HOME: f.root,
      TINKER_MODEL: "test-model",
      TINKER_API_KEY: "test-key",
      TINKER_BASE_URL: "https://example.test/v1",
      TINKER_CONTEXT_WINDOW_TOKENS: "262144",
      TINKER_MAX_SUPPORTED_OUTPUT_TOKENS: "65536",
    },
    f.root,
  );
  let runtime;
  try {
    const extra = path.join(f.root, "new-workspace");
    await mkdir(extra);
    entries.push({ id: "added", name: "Added", path: extra });
    const record: ManagedSessionRecord = {
      id: createUuidV7(),
      workspaceId: "added",
      workspacePath: extra,
      title: "New",
      modelName: "",
      owner: "service",
      status: "accepted",
      initialized: false,
      updatedAt: new Date().toISOString(),
    };
    runtime = (
      await factory({
        record,
        sink: {
          name: "test",
          append: async () => {},
          updateAssistantTextDelta: () => {},
        },
      })
    ).runtime;
    expect(
      (
        await new SessionCatalog({ workspaceRoot: extra, homeRoot: f.root }).get(
          parseSessionId(record.id),
        )
      ).modelName,
    ).toBe("test-model");
  } finally {
    await runtime?.dispose({ type: "tui_exit" });
    await f.cleanup();
  }
});
