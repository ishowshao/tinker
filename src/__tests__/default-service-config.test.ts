import { expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  prepareDefaultServiceConfig,
  prepareDefaultConnection,
} from "../cli/default-service-config";
import {
  defaultServiceConfigPath,
  discoverLocalService,
  loadLocalServiceTarget,
} from "../remote/local-service-discovery";
import { loadRemoteClientConfig, RemoteClient } from "../remote/client";
import { resolveConnectedWorkspace } from "../cli/connect-workspace";

async function fixture() {
  const root = await realpath(await mkdtemp("/tmp/tinker-default-"));
  const env = { PATH: process.env.PATH, TINKER_HOME: root };
  const configPath = defaultServiceConfigPath(env);
  const stop = async () => {
    if (!(await Bun.file(configPath).exists())) return;
    const target = await loadLocalServiceTarget(configPath, env);
    const live = await discoverLocalService(target);
    if (live) process.kill(live.pid, "SIGTERM");
    const deadline = Date.now() + 5000;
    while (
      await Bun.file(path.join(target.config.stateDirectory, "active.lock")).exists()
    ) {
      expect(Date.now()).toBeLessThan(deadline);
      await Bun.sleep(25);
    }
  };
  return {
    root,
    env,
    configPath,
    stop,
    async cleanup() {
      await stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("concurrent first launches publish one private credential bundle and reuse one service across roots and restart", async () => {
  const f = await fixture();
  try {
    const configs = await Promise.all(
      Array.from({ length: 4 }, () => prepareDefaultConnection(f.env)),
    );
    expect(new Set(configs.map((c) => c.configPath)).size).toBe(1);
    const first = await loadLocalServiceTarget(f.configPath, f.env);
    const service = await discoverLocalService(first);
    expect(service).toBeDefined();
    const config = await loadRemoteClientConfig(configs[0].configPath);
    const token = config.token;
    expect(config.url).toBe(service!.url);
    for (const name of ["service.json", "client.json", "server.key", "server.crt"])
      expect(
        (await stat(path.join(path.dirname(f.configPath), name))).mode & 0o777,
      ).toBe(0o600);
    expect((await stat(path.dirname(f.configPath))).mode & 0o777).toBe(0o700);
    const roots = [path.join(f.root, "one"), path.join(f.root, "two")];
    await Promise.all(roots.map((root) => mkdir(root)));
    const workspaces = await Promise.all(
      roots.map((cwd) =>
        resolveConnectedWorkspace({
          config,
          cwd,
          env: f.env,
          serviceConfigPath: f.configPath,
        }),
      ),
    );
    expect(new Set(workspaces).size).toBe(2);
    const remote = new RemoteClient(config, false);
    try {
      expect((await remote.workspaces()).workspaces).toHaveLength(2);
    } finally {
      await remote.close();
    }
    await f.stop();
    const again = await prepareDefaultConnection(f.env);
    const next = await discoverLocalService(first);
    expect(next!.instanceId).not.toBe(service!.instanceId);
    const paired = await loadRemoteClientConfig(again.configPath);
    expect(paired.token).toBe(token);
    expect(paired.url).toBe(next!.url);
    expect(
      await resolveConnectedWorkspace({ config: paired, cwd: roots[0], env: f.env }),
    ).toBe(workspaces[0]);
  } finally {
    await f.cleanup();
  }
}, 20000);

test("existing incomplete configuration and revoked client credentials are never regenerated or started", async () => {
  const f = await fixture();
  try {
    await mkdir(path.dirname(f.configPath), { recursive: true });
    expect(
      String(await prepareDefaultServiceConfig(f.env).catch((error: unknown) => error)),
    ).toContain("no service.json");
    await rm(path.dirname(f.configPath), { recursive: true });
    await prepareDefaultServiceConfig(f.env);
    const original = await readFile(f.configPath, "utf8");
    const clientPath = path.join(path.dirname(f.configPath), "client.json");
    const client = JSON.parse(await readFile(clientPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(clientPath, JSON.stringify({ ...client, token: "x".repeat(43) }));
    expect(
      String(await prepareDefaultConnection(f.env).catch((error: unknown) => error)),
    ).toContain("credentials do not match");
    expect(await readFile(f.configPath, "utf8")).toBe(original);
    expect(
      await discoverLocalService(await loadLocalServiceTarget(f.configPath, f.env)),
    ).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

test("non-interactive default entry fails before creating configuration or starting a daemon", async () => {
  const f = await fixture();
  try {
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "../cli/index.ts")],
      {
        cwd: f.root,
        env: f.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("interactive terminal");
    expect(await Bun.file(f.configPath).exists()).toBe(false);
  } finally {
    await f.cleanup();
  }
});
