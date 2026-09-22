import { createHash, randomUUID } from "node:crypto";
import { createConnection, createServer } from "node:net";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { defaultHomeRoot } from "../session/workspace-storage";
import { loadRemoteConfig, type RemoteServiceConfig } from "./config";

export type LocalServiceTarget = {
  configPath: string;
  config: RemoteServiceConfig;
  fingerprint: string;
  homeRoot: string;
};
export type LocalServiceInstance = {
  version: 1;
  appVersion?: string;
  packageRoot?: string;
  instanceId: string;
  pid: number;
  startedAt: string;
  configPath: string;
  stateDirectory: string;
  fingerprint: string;
  url: string;
};

export function defaultServiceConfigPath(env: NodeJS.ProcessEnv): string {
  return path.resolve(defaultHomeRoot(env), ".tinker/service/service.json");
}

export async function loadLocalServiceTarget(
  configPath: string,
  env: NodeJS.ProcessEnv,
): Promise<LocalServiceTarget> {
  const canonicalPath = await realpath(configPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(
        `Service configuration not found: ${configPath}. Create it or use --config <path>.`,
      );
    throw error;
  });
  const config = await loadRemoteConfig(canonicalPath);
  const homeRoot = await realpath(defaultHomeRoot(env));
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ config, homeRoot }))
    .update(await readFile(config.tls.certFile))
    .update(await readFile(config.tls.keyFile))
    .digest("hex");
  return { configPath: canonicalPath, config, fingerprint, homeRoot };
}

export function localServicePaths(directory: string) {
  // Keep Unix paths short even when workspaces/state live deep in macOS temp roots.
  const socketRoot = `/tmp/tinker-service-${process.getuid?.() ?? "unknown"}`;
  const name = createHash("sha256").update(directory).digest("hex").slice(0, 32);
  return {
    socket: path.join(socketRoot, `${name}.sock`),
    instance: path.join(directory, "service-instance.json"),
    log: path.join(directory, "service.log"),
    startup: path.join(directory, "startup"),
  };
}

/** Live, read-only local probe. A PID or a leftover descriptor never proves readiness. */
export async function discoverLocalService(
  target: LocalServiceTarget,
  allowDifferentConfig = false,
): Promise<LocalServiceInstance | undefined> {
  return (await requestLocalService(target, undefined, undefined, allowDifferentConfig))
    ?.instance;
}

export async function shutdownLocalService(
  target: LocalServiceTarget,
  force: boolean,
): Promise<LocalServiceInstance | undefined> {
  return (await requestLocalService(target, undefined, { force }))?.instance;
}

export async function registerLocalWorkspace(
  target: LocalServiceTarget,
  directory: string,
): Promise<RemoteServiceConfig["workspaces"][number]> {
  const response = await requestLocalService(target, directory);
  if (!response?.workspace)
    throw new Error("Local service is not ready for workspace registration.");
  return response.workspace;
}

type LocalServiceReply = {
  instance: LocalServiceInstance;
  workspace?: RemoteServiceConfig["workspaces"][number];
  error?: string;
};

async function requestLocalService(
  target: LocalServiceTarget,
  directory?: string,
  shutdown?: { force: boolean },
  allowDifferentConfig = false,
): Promise<LocalServiceReply | undefined> {
  if (process.platform === "win32")
    throw new Error("Local service discovery currently requires macOS/Linux.");
  const socketPath = localServicePaths(target.config.stateDirectory).socket;
  try {
    const root = await lstat(path.dirname(socketPath));
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      root.uid !== process.getuid?.() ||
      (root.mode & 0o077) !== 0
    )
      throw new Error(
        "Local discovery socket directory has unsafe ownership or permissions.",
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const nonce = randomUUID();
  const response = await new Promise<LocalServiceReply | undefined>(
    (resolve, reject) => {
      const socket = createConnection(socketPath);
      socket.setEncoding("utf8");
      let text = "";
      let settled = false;
      const finish = (value?: LocalServiceReply, error?: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      };
      socket.setTimeout(
        shutdown
          ? (target.config.resident?.shutdownGraceMs ?? 30000) + 15000
          : directory === undefined
            ? 1000
            : 10000,
        () => finish(),
      );
      socket.once("error", (error: NodeJS.ErrnoException) => {
        if (["ENOENT", "ECONNREFUSED", "ECONNRESET"].includes(error.code ?? ""))
          finish();
        else finish(undefined, error);
      });
      socket.once("connect", () =>
        socket.write(
          `${shutdown ? JSON.stringify({ nonce, command: "shutdown", force: shutdown.force }) : directory === undefined ? nonce : JSON.stringify({ nonce, command: "register-workspace", directory, fingerprint: target.fingerprint })}\n`,
        ),
      );
      socket.on("data", (chunk: string) => {
        text += chunk;
        if (text.length > 16384)
          return finish(undefined, new Error("Invalid local service response."));
        if (!text.includes("\n")) return;
        try {
          const response = JSON.parse(text.trim()) as LocalServiceReply & {
            nonce?: unknown;
          };
          const value = response.instance;
          if (
            response.nonce !== nonce ||
            value?.version !== 1 ||
            typeof value.instanceId !== "string" ||
            !Number.isInteger(value.pid) ||
            typeof value.url !== "string" ||
            typeof value.fingerprint !== "string"
          )
            throw new Error("Invalid local service response.");
          finish(response);
        } catch (error) {
          finish(
            undefined,
            error instanceof Error
              ? error
              : new Error("Invalid local service response."),
          );
        }
      });
      socket.once("end", () => finish());
    },
  );
  if (
    !shutdown &&
    !allowDifferentConfig &&
    response &&
    response.instance.fingerprint !== target.fingerprint
  )
    throw new Error(
      "The running service uses different configuration or TINKER_HOME. Stop it before changing configuration.",
    );
  if (shutdown && response?.error?.startsWith("Invalid local workspace registration"))
    throw new Error(
      `This older service cannot drain through the control endpoint. Stop its verified live pid ${response.instance.pid} explicitly, then retry.`,
    );
  if (response?.error) throw new Error(response.error);
  return response;
}

/** Called only while the canonical service lease is held, after HTTPS is listening. */
export async function publishLocalService(
  target: LocalServiceTarget,
  instanceId: string,
  port: number,
  registerWorkspace?: (
    directory: string,
  ) => Promise<RemoteServiceConfig["workspaces"][number]>,
  administration?: {
    appVersion: string;
    status(): Record<string, unknown>;
    shutdown(force: boolean): Promise<() => void>;
  },
): Promise<() => Promise<void>> {
  const files = localServicePaths(target.config.stateDirectory);
  const socketRoot = path.dirname(files.socket);
  await mkdir(socketRoot, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(socketRoot);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    rootStat.uid !== process.getuid?.() ||
    (rootStat.mode & 0o077) !== 0
  )
    throw new Error(
      "Local discovery socket directory has unsafe ownership or permissions.",
    );
  const instance: LocalServiceInstance = {
    version: 1,
    appVersion: administration?.appVersion,
    packageRoot: await realpath(new URL("../../", import.meta.url)),
    instanceId,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    configPath: target.configPath,
    stateDirectory: target.config.stateDirectory,
    fingerprint: target.fingerprint,
    url: `https://${target.config.hostname === "::1" ? "[::1]" : target.config.hostname}:${port}`,
  };
  await removeIfMissing(files.socket);
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let input = "";
    let handling = false;
    socket.setTimeout(1000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: string) => {
      if (handling) return;
      input += chunk;
      if (input.length > 8192) {
        socket.destroy();
        return;
      }
      if (!input.includes("\n")) return;
      handling = true;
      socket.setTimeout(
        (target.config.resident?.shutdownGraceMs ?? 30000) + 15000,
        () => socket.destroy(),
      );
      const reply = async () => {
        let nonce = input.trim();
        try {
          if (!input.startsWith("{")) {
            socket.end(
              `${JSON.stringify({ nonce, instance: { ...instance, ...administration?.status() } })}\n`,
            );
            return;
          }
          const command = JSON.parse(input.trim()) as {
            nonce: string;
            command: string;
            directory: string;
            fingerprint: string;
            force?: boolean;
          };
          nonce = command.nonce;
          if (
            command.command === "shutdown" &&
            administration &&
            typeof nonce === "string" &&
            nonce.length <= 100 &&
            typeof command.force === "boolean"
          ) {
            const stop = await administration.shutdown(command.force);
            socket.end(`${JSON.stringify({ nonce, instance })}\n`);
            setTimeout(stop, 100);
            return;
          }
          if (
            typeof nonce !== "string" ||
            nonce.length > 100 ||
            command.command !== "register-workspace" ||
            typeof command.directory !== "string" ||
            command.fingerprint !== target.fingerprint ||
            !registerWorkspace
          )
            throw new Error(
              "Invalid local workspace registration request or service configuration changed.",
            );
          const workspace = await registerWorkspace(command.directory);
          socket.end(`${JSON.stringify({ nonce, instance, workspace })}\n`);
        } catch (error) {
          socket.end(
            `${JSON.stringify({ nonce, instance, error: error instanceof Error ? error.message : String(error) })}\n`,
          );
        }
      };
      void reply();
    });
  });
  let listening = false;
  const temp = `${files.instance}.${instanceId}.tmp`;
  const discoveryTemp = `${files.socket}.json.${instanceId}.tmp`;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(files.socket, () => {
        listening = true;
        resolve();
      });
    });
    await chmod(files.socket, 0o600);
    await writeFile(temp, `${JSON.stringify(instance)}\n`, { mode: 0o600 });
    await rename(temp, files.instance);
    await writeFile(discoveryTemp, `${JSON.stringify(instance)}\n`, {
      mode: 0o600,
    });
    await rename(discoveryTemp, `${files.socket}.json`);
  } catch (error) {
    await removeIfMissing(discoveryTemp);
    if (listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeIfMissing(temp);
    throw error;
  }
  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeIfMissing(files.instance);
    // Keep the installation guard while launchd may restart this process.
    if (
      !(await Bun.file(
        path.join(target.config.stateDirectory, "supervisor.enabled"),
      ).exists())
    )
      await removeIfMissing(`${files.socket}.json`);
  };
}

async function removeIfMissing(filename: string): Promise<void> {
  await unlink(filename).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}
