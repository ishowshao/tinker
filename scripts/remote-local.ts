import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { mkdir, readFile, writeFile, access, realpath } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { command, createRemoteCertificates } from "./remote/certificates";

const ROOT = path.resolve(import.meta.dir, "..");
const FRP_VERSION = "0.71.0";
const FRP_HASHES: Record<string, string> = {
  arm64: "45be02b186860d375ed49a8941ae9569628a54bf14e67fc36b29c98c99dabcc6",
  x64: "1b1b4e2f1836e21e8733f1dddaacd4ed9ae67d7dbee39046b9d7b7eda6253637",
};
type Component = "relay" | "tunnel" | "service";
type Processes = Partial<Record<Component, { pid: number; config: string }>>;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      directory: {
        type: "string",
        default: path.join(ROOT, ".tinker", "remote-local"),
      },
      workspace: { type: "string", default: ROOT },
      host: { type: "string" },
      profile: { type: "string" },
    },
  });
  const directory = path.resolve(values.directory);
  const action = positionals[0] ?? "status";
  if (action === "setup") {
    await setup(
      directory,
      await realpath(values.workspace),
      values.host,
      values.profile,
    );
    return;
  }
  const component = positionals[1];
  if (component && !["relay", "tunnel", "service"].includes(component))
    throw new Error("Component must be relay, tunnel or service.");
  const selected = component
    ? [component as Component]
    : (["relay", "service", "tunnel"] as Component[]);
  const recordsPath = path.join(directory, "processes.json");
  let records: Processes;
  try {
    records = JSON.parse(await readFile(recordsPath, "utf8")) as Processes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    records = {};
  }
  for (const name of action === "down" ? [...selected].reverse() : selected) {
    const record = records[name];
    const alive = record ? await isOwnedProcess(record) : false;
    if (action === "status") {
      console.log(`${name}: ${alive ? `running (pid ${record!.pid})` : "stopped"}`);
      continue;
    }
    if (action === "down") {
      if (alive) {
        process.kill(record!.pid, "SIGTERM");
        console.log(`${name}: stopping`);
      } else console.log(`${name}: already stopped`);
      continue;
    }
    if (action !== "up")
      throw new Error(
        "Usage: remote-local.ts setup|up|down|status [relay|tunnel|service] [--directory path] [--host LAN_IP] [--workspace path] [--profile name]",
      );
    if (alive) {
      console.log(`${name}: already running`);
      continue;
    }
    const file = path.join(
      directory,
      name === "relay" ? "frps.toml" : name === "tunnel" ? "frpc.toml" : "service.json",
    );
    await access(file);
    const binaryRoot = path.join(
      directory,
      `frp_${FRP_VERSION}_darwin_${process.arch === "arm64" ? "arm64" : "amd64"}`,
    );
    const executable =
      name === "service"
        ? process.execPath
        : path.join(binaryRoot, name === "relay" ? "frps" : "frpc");
    const args =
      name === "service"
        ? [path.join(ROOT, "src/cli/index.ts"), "serve", "--config", file]
        : ["-c", file];
    const log = openSync(path.join(directory, `${name}.log`), "a", 0o600);
    try {
      const child = spawn(executable, args, {
        detached: true,
        cwd: ROOT,
        env: process.env,
        stdio: ["ignore", log, log],
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
      records[name] = { pid: child.pid!, config: file };
      await writeFile(recordsPath, JSON.stringify(records, null, 2), { mode: 0o600 });
      console.log(`${name}: started (pid ${child.pid})`);
    } finally {
      closeSync(log);
    }
  }
}

async function isOwnedProcess(record: {
  pid: number;
  config: string;
}): Promise<boolean> {
  if (!Number.isSafeInteger(record.pid) || record.pid < 1) return false;
  try {
    const args = await command(["ps", "-p", String(record.pid), "-o", "command="]);
    return args.includes(record.config);
  } catch {
    return false;
  }
}

async function setup(
  directory: string,
  workspace: string,
  configuredHost?: string,
  profile?: string,
): Promise<void> {
  if (process.platform !== "darwin" || !FRP_HASHES[process.arch])
    throw new Error(
      "This local launcher supports macOS arm64/x64. See the deployment runbook for Linux frps.",
    );
  try {
    await access(path.join(directory, "service.json"));
    throw new Error(
      "Configuration already exists; use a new --directory to keep existing pairing credentials intact.",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const host =
    configuredHost ??
    Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address ??
    "127.0.0.1";
  const certs = path.join(directory, "certs");
  await createRemoteCertificates(certs, [host]);
  const filename = `frp_${FRP_VERSION}_darwin_${process.arch === "arm64" ? "arm64" : "amd64"}.tar.gz`;
  const url = `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${filename}`;
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Cannot download pinned frp: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(archive).digest("hex") !== FRP_HASHES[process.arch])
    throw new Error("Pinned frp archive checksum does not match.");
  const archivePath = path.join(directory, filename);
  await writeFile(archivePath, archive, { mode: 0o600 });
  await command(["tar", "-xzf", archivePath, "-C", directory]);
  const token = randomBytes(32).toString("base64url");
  const tunnelToken = randomBytes(32).toString("base64url");
  const pem = (file: string) => JSON.stringify(path.join(certs, file));
  const files: Record<string, string> = {
    "frps.toml": `bindAddr = "127.0.0.1"\nbindPort = 17000\nproxyBindAddr = "0.0.0.0"\nallowPorts = [{ single = 18443 }]\nauth.method = "token"\nauth.token = ${JSON.stringify(tunnelToken)}\ntransport.tls.force = true\ntransport.tls.certFile = ${pem("frps.crt")}\ntransport.tls.keyFile = ${pem("frps.key")}\ntransport.tls.trustedCaFile = ${pem("ca.crt")}\n`,
    "frpc.toml": `serverAddr = "127.0.0.1"\nserverPort = 17000\nloginFailExit = false\nauth.method = "token"\nauth.token = ${JSON.stringify(tunnelToken)}\ntransport.tls.enable = true\ntransport.tls.serverName = "localhost"\ntransport.tls.certFile = ${pem("frpc.crt")}\ntransport.tls.keyFile = ${pem("frpc.key")}\ntransport.tls.trustedCaFile = ${pem("ca.crt")}\n[[proxies]]\nname = "tinker-https"\ntype = "tcp"\nlocalIP = "127.0.0.1"\nlocalPort = 19443\nremotePort = 18443\n`,
    "service.json": JSON.stringify(
      {
        version: 1,
        stateDirectory: path.join(directory, "state"),
        hostname: "127.0.0.1",
        port: 19443,
        tls: {
          certFile: path.join(certs, "app.crt"),
          keyFile: path.join(certs, "app.key"),
        },
        devices: [
          {
            id: "development-phone",
            name: "Development iPhone and terminal",
            tokenSha256: createHash("sha256").update(token).digest("hex"),
          },
        ],
        workspaces: [
          {
            id: "workspace",
            name: path.basename(workspace),
            path: workspace,
            ...(profile ? { profile } : {}),
          },
        ],
      },
      null,
      2,
    ),
    "client.json": JSON.stringify(
      {
        version: 1,
        url: `https://127.0.0.1:18443`,
        token,
        caFile: path.join(certs, "ca.crt"),
      },
      null,
      2,
    ),
    "pairing.json": JSON.stringify(
      {
        version: 1,
        name: "Tinker local development",
        url: `https://${host}:18443`,
        token,
        certificateSha256: new X509Certificate(
          await readFile(path.join(certs, "app.crt")),
        ).fingerprint256
          .replaceAll(":", "")
          .toLowerCase(),
      },
      null,
      2,
    ),
  };
  for (const [name, content] of Object.entries(files))
    await writeFile(path.join(directory, name), `${content}\n`, { mode: 0o600 });
  const binary = path.join(directory, filename.replace(".tar.gz", ""));
  await command([
    path.join(binary, "frps"),
    "verify",
    "-c",
    path.join(directory, "frps.toml"),
  ]);
  await command([
    path.join(binary, "frpc"),
    "verify",
    "-c",
    path.join(directory, "frpc.toml"),
  ]);
  console.log(
    `Local relay, verified mTLS tunnel, service and pairing configuration created in ${directory}.\nApp endpoint: https://${host}:18443\nImport pairing.json in the iPhone app; keep this private file off Git.\nStart: bun scripts/remote-local.ts up --directory ${JSON.stringify(directory)}`,
  );
}

if (import.meta.main) await main();
