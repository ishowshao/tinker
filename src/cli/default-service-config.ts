import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultServiceConfigPath,
  loadLocalServiceTarget,
} from "../remote/local-service-discovery";
import { loadRemoteClientConfig } from "../remote/client";
import { authenticateDevice } from "../remote/config";
import { ensureLocalService } from "./local-service-start";

/** Publish an entire credential/config bundle atomically; competing first launches reuse the winner. */
export async function prepareDefaultServiceConfig(
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (process.platform === "win32")
    throw new Error(
      "Default service startup requires macOS/Linux. Use tinker --local on Windows.",
    );
  const configPath = defaultServiceConfigPath(env);
  const directory = path.dirname(configPath);
  if (await exists(directory)) {
    if (!(await exists(configPath)))
      throw new Error(
        `Service directory has no service.json: ${directory}. Complete its configuration or use tinker --local.`,
      );
    return configPath;
  }
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  const temporary = `${directory}.setup-${randomUUID()}`;
  await mkdir(temporary, { mode: 0o700 });
  try {
    const child = Bun.spawn(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-sha256",
        "-days",
        "365",
        "-subj",
        "/CN=Tinker local service",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-keyout",
        path.join(temporary, "server.key"),
        "-out",
        path.join(temporary, "server.crt"),
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const [error, code] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0)
      throw new Error(`Cannot prepare local TLS certificate: ${error.trim()}`);
    await chmod(path.join(temporary, "server.key"), 0o600);
    await chmod(path.join(temporary, "server.crt"), 0o600);
    const token = randomBytes(32).toString("base64url");
    await writeFile(
      path.join(temporary, "service.json"),
      JSON.stringify(
        {
          version: 1,
          localBootstrap: 1,
          hostname: "127.0.0.1",
          port: 0,
          tls: { certFile: "./server.crt", keyFile: "./server.key" },
          devices: [
            {
              id: "local-terminal",
              name: "Local terminal",
              tokenSha256: createHash("sha256").update(token).digest("hex"),
            },
          ],
          workspaces: [],
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    await writeFile(
      path.join(temporary, "client.json"),
      JSON.stringify(
        {
          url: "https://127.0.0.1:1",
          token,
          caFile: "./server.crt",
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    try {
      await rename(temporary, directory);
    } catch (error) {
      if (
        !["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")
      )
        throw error;
      if (!(await exists(configPath)))
        throw new Error(`Incomplete service configuration at ${directory}.`, {
          cause: error,
        });
    }
    return configPath;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function prepareDefaultConnection(env: NodeJS.ProcessEnv) {
  const serviceConfigPath = await prepareDefaultServiceConfig(env);
  const configPath = path.join(path.dirname(serviceConfigPath), "client.json");
  // Validate credentials before starting a service; never replace an existing pairing.
  const client = await loadRemoteClientConfig(configPath);
  const target = await loadLocalServiceTarget(serviceConfigPath, env);
  if (!authenticateDevice(`Bearer ${client.token}`, target.config.devices))
    throw new Error(
      `Local client credentials do not match ${serviceConfigPath}. Repair client.json before connecting.`,
    );
  const instance = await ensureLocalService(target, env);
  const raw = JSON.parse(await readFile(serviceConfigPath, "utf8")) as {
    localBootstrap?: unknown;
  };
  if (raw.localBootstrap === 1) {
    // Auto-created local pairing follows the actual loopback port after every restart.
    const pairing = JSON.parse(await readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    const temporary = `${configPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        JSON.stringify({ ...pairing, url: instance.url }, null, 2) + "\n",
        { mode: 0o600 },
      );
      await rename(temporary, configPath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return { serviceConfigPath, configPath };
}

async function exists(filename: string): Promise<boolean> {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
