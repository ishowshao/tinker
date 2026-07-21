import path from "node:path";
import process from "node:process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { requireUuid } from "./protocol-v1";

export type RuntimeRegistryV1 = {
  schemaVersion: 1;
  protocolVersion: 1;
  runtimeId: string;
  pid: number;
  socketPath: string;
  authToken: string;
  cwd: string;
  startedAt: string;
};

export type RuntimeDirectories = {
  root: string;
  runtimes: string;
  sockets: string;
};

export type RuntimeRegistryScan = {
  live: RuntimeRegistryV1[];
  invalidEntries: Array<{ path: string; error: string }>;
};

export function defaultRuntimeRoot(): string {
  const configured = process.env.TINKER_CHROME_RUNTIME_ROOT?.trim();
  if (configured !== undefined && configured !== "") {
    if (!path.isAbsolute(configured)) {
      throw new Error("TINKER_CHROME_RUNTIME_ROOT must be an absolute path.");
    }
    return path.normalize(configured);
  }

  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("Tinker Chrome requires a POSIX user ID.");
  }
  return `/tmp/tinker-chrome-${uid}`;
}

export function runtimeDirectories(
  root: string = defaultRuntimeRoot(),
): RuntimeDirectories {
  const normalized = path.normalize(root);
  if (!path.isAbsolute(normalized)) {
    throw new Error("Runtime root must be an absolute path.");
  }
  return {
    root: normalized,
    runtimes: path.join(normalized, "runtimes"),
    sockets: path.join(normalized, "sockets"),
  };
}

export function runtimeSocketPath(
  runtimeId: string,
  directories: RuntimeDirectories,
): string {
  const compactId = requireUuid(runtimeId, "runtimeId").replaceAll("-", "");
  return path.join(directories.sockets, `${compactId.slice(0, 16)}.sock`);
}

export function runtimeRegistryPath(
  runtimeId: string,
  directories: RuntimeDirectories,
): string {
  return path.join(directories.runtimes, `${requireUuid(runtimeId, "runtimeId")}.json`);
}

export async function ensureRuntimeDirectories(
  directories: RuntimeDirectories,
): Promise<void> {
  await ensurePrivateDirectory(directories.root);
  await ensurePrivateDirectory(directories.runtimes);
  await ensurePrivateDirectory(directories.sockets);
}

export async function publishRuntimeRegistry(
  registry: RuntimeRegistryV1,
  directories: RuntimeDirectories,
): Promise<string> {
  validateRuntimeRegistry(registry, directories);
  await ensureRuntimeDirectories(directories);

  const destination = runtimeRegistryPath(registry.runtimeId, directories);
  const temporary = path.join(
    directories.runtimes,
    `.${registry.runtimeId}.${process.pid}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return destination;
}

export async function removeRuntimeRegistry(
  registry: RuntimeRegistryV1,
  directories: RuntimeDirectories,
): Promise<void> {
  validateRuntimeRegistry(registry, directories);
  await unlink(runtimeRegistryPath(registry.runtimeId, directories)).catch(
    ignoreMissing,
  );
  await removeOwnedSocket(registry.socketPath, directories);
}

export async function scanRuntimeRegistries(options?: {
  root?: string;
  cleanupStale?: boolean;
}): Promise<RuntimeRegistryScan> {
  const directories = runtimeDirectories(options?.root);
  await ensureRuntimeDirectories(directories);

  const entries = await readdir(directories.runtimes, { withFileTypes: true });
  const live: RuntimeRegistryV1[] = [];
  const invalidEntries: RuntimeRegistryScan["invalidEntries"] = [];

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const registryPath = path.join(directories.runtimes, entry.name);
    try {
      const registry = parseRuntimeRegistry(
        await readFile(registryPath, "utf8"),
        directories,
      );
      if (entry.name !== `${registry.runtimeId}.json`) {
        throw new Error("Registry filename does not match runtimeId.");
      }

      const registryStat = await lstat(registryPath);
      requireCurrentUser(registryStat.uid, registryPath);
      if ((registryStat.mode & 0o077) !== 0) {
        throw new Error(
          "Registry file permissions must not allow group or other access.",
        );
      }

      if (isProcessLive(registry.pid)) {
        live.push(registry);
        continue;
      }

      if (options?.cleanupStale === true) {
        await unlink(registryPath);
        await removeOwnedSocket(registry.socketPath, directories);
      }
    } catch (error) {
      invalidEntries.push({
        path: registryPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { live, invalidEntries };
}

export function parseRuntimeRegistry(
  raw: string,
  directories: RuntimeDirectories,
): RuntimeRegistryV1 {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error("Runtime registry is not valid JSON.", { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Runtime registry must be an object.");
  }

  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "schemaVersion",
    "protocolVersion",
    "runtimeId",
    "pid",
    "socketPath",
    "authToken",
    "cwd",
    "startedAt",
  ];
  if (
    Object.keys(record).length !== expectedKeys.length ||
    expectedKeys.some((key) => !(key in record))
  ) {
    throw new Error("Runtime registry has missing or unknown fields.");
  }

  const registry: RuntimeRegistryV1 = {
    schemaVersion: requireOne(record.schemaVersion, "schemaVersion"),
    protocolVersion: requireOne(record.protocolVersion, "protocolVersion"),
    runtimeId: requireUuid(record.runtimeId, "runtimeId"),
    pid: requirePositiveInteger(record.pid, "pid"),
    socketPath: requireNonEmptyString(record.socketPath, "socketPath"),
    authToken: requireNonEmptyString(record.authToken, "authToken"),
    cwd: requireNonEmptyString(record.cwd, "cwd"),
    startedAt: requireIsoDate(record.startedAt, "startedAt"),
  };
  validateRuntimeRegistry(registry, directories);
  return registry;
}

export function validateRuntimeRegistry(
  registry: RuntimeRegistryV1,
  directories: RuntimeDirectories,
): void {
  requireUuid(registry.runtimeId, "runtimeId");
  if (registry.schemaVersion !== 1 || registry.protocolVersion !== 1) {
    throw new Error("Runtime registry requires schema and protocol version 1.");
  }
  if (!Number.isSafeInteger(registry.pid) || registry.pid <= 0) {
    throw new Error("Runtime registry pid must be a positive integer.");
  }
  const expectedSocket = runtimeSocketPath(registry.runtimeId, directories);
  if (path.normalize(registry.socketPath) !== expectedSocket) {
    throw new Error("Runtime registry socketPath is outside the sockets directory.");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(registry.authToken)) {
    throw new Error("Runtime registry authToken must be 32-byte base64url.");
  }
  if (!path.isAbsolute(registry.cwd)) {
    throw new Error("Runtime registry cwd must be absolute.");
  }
  requireIsoDate(registry.startedAt, "startedAt");
}

function isProcessLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasErrorCode(error, "EPERM");
  }
}

async function ensurePrivateDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const stat = await lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${directoryPath} must be a real directory.`);
  }
  requireCurrentUser(stat.uid, directoryPath);
  await chmod(directoryPath, 0o700);
}

async function removeOwnedSocket(
  socketPath: string,
  directories: RuntimeDirectories,
): Promise<void> {
  const normalized = path.normalize(socketPath);
  if (path.dirname(normalized) !== directories.sockets) {
    throw new Error("Refusing to remove a socket outside the runtime directory.");
  }
  try {
    const stat = await lstat(normalized);
    requireCurrentUser(stat.uid, normalized);
    if (!stat.isSocket()) {
      throw new Error(`Refusing to remove non-socket path ${normalized}.`);
    }
    await unlink(normalized);
  } catch (error) {
    ignoreMissing(error);
  }
}

function requireCurrentUser(uid: number, targetPath: string): void {
  const currentUid = process.getuid?.();
  if (currentUid === undefined || uid !== currentUid) {
    throw new Error(`${targetPath} is not owned by the current user.`);
  }
}

function requireOne(value: unknown, label: string): 1 {
  if (value !== 1) {
    throw new Error(`${label} must be 1.`);
  }
  return 1;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value as number;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireIsoDate(value: unknown, label: string): string {
  const text = requireNonEmptyString(value, label);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== text) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
  return text;
}

function ignoreMissing(error: unknown): void {
  if (!hasErrorCode(error, "ENOENT")) {
    throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
