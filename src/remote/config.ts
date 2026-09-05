import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { requireId, requireObject, requireText } from "./protocol";

export type RemoteWorkspaceConfig = {
  id: string;
  name: string;
  path: string;
  profile?: string;
};
export type RemoteServiceConfig = {
  stateDirectory: string;
  hostname: string;
  port: number;
  tls: { certFile: string; keyFile: string };
  devices: { id: string; name: string; tokenSha256: string }[];
  workspaces: RemoteWorkspaceConfig[];
};

export async function loadRemoteConfig(file: string): Promise<RemoteServiceConfig> {
  const absolute = path.resolve(file);
  const raw = requireObject(JSON.parse(await readFile(absolute, "utf8")));
  if (raw.version !== 1)
    throw new Error("Remote service configuration version must be 1.");
  const resolve = (value: unknown, name: string) =>
    path.resolve(path.dirname(absolute), requireText(value, name, 4096));
  const tls = requireObject(raw.tls);
  const port = raw.port ?? 9443;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid service port.");
  if (!Array.isArray(raw.devices) || raw.devices.length === 0)
    throw new Error("At least one paired device is required.");
  if (!Array.isArray(raw.workspaces) || raw.workspaces.length === 0)
    throw new Error("At least one workspace is required.");
  const devices = raw.devices.map((entry) => {
    const device = requireObject(entry);
    const tokenSha256 = requireText(device.tokenSha256, "tokenSha256", 64);
    if (!/^[0-9a-f]{64}$/.test(tokenSha256))
      throw new Error("Device tokenSha256 must be a lowercase SHA-256 digest.");
    return {
      id: requireId(device.id, "device.id"),
      name: requireText(device.name, "device.name", 240),
      tokenSha256,
    };
  });
  const workspaces: RemoteWorkspaceConfig[] = [];
  for (const entry of raw.workspaces) {
    const workspace = requireObject(entry);
    const root = await realpath(resolve(workspace.path, "workspace.path"));
    if (!(await stat(root)).isDirectory())
      throw new Error("Workspace must be a directory.");
    workspaces.push({
      id: requireId(workspace.id, "workspace.id"),
      name: requireText(workspace.name, "workspace.name", 240),
      path: root,
      ...(workspace.profile === undefined
        ? {}
        : { profile: requireText(workspace.profile, "workspace.profile", 240) }),
    });
  }
  if (
    new Set(devices.map((d) => d.id)).size !== devices.length ||
    new Set(workspaces.map((w) => w.id)).size !== workspaces.length ||
    new Set(workspaces.map((w) => w.path)).size !== workspaces.length
  )
    throw new Error("Duplicate device/workspace identity.");
  const hostname = raw.hostname ?? "127.0.0.1";
  if (hostname !== "127.0.0.1" && hostname !== "::1")
    throw new Error("Bind the service to loopback; expose only the relay TCP port.");
  return {
    stateDirectory: resolve(raw.stateDirectory, "stateDirectory"),
    hostname,
    port,
    tls: {
      certFile: resolve(tls.certFile, "tls.certFile"),
      keyFile: resolve(tls.keyFile, "tls.keyFile"),
    },
    devices,
    workspaces,
  };
}

export function authenticateDevice(
  header: string | null,
  devices: RemoteServiceConfig["devices"],
): string | undefined {
  if (!header?.startsWith("Bearer ") || header.length > 256) return undefined;
  const token = header.slice(7);
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) return undefined;
  const digest = createHash("sha256").update(token).digest();
  return devices.find((device) =>
    timingSafeEqual(digest, Buffer.from(device.tokenSha256, "hex")),
  )?.id;
}
