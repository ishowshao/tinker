import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { EXTENSION_ID, EXTENSION_ORIGIN, NATIVE_HOST_NAME } from "./constants";
import { defaultRuntimeRoot } from "./runtime-registry";

export type NativeHostConfigV1 = {
  schemaVersion: 1;
  nativeHostName: string;
  extensionOrigin: string;
  runtimeRoot: string;
};

export type NativeHostInstallation = {
  home: string;
  executablePath: string;
  configPath: string;
  manifestPaths: string[];
  extensionId: string;
};

export function tinkerChromeHome(): string {
  const configured = process.env.TINKER_CHROME_HOME?.trim();
  if (configured !== undefined && configured !== "") {
    if (!path.isAbsolute(configured)) {
      throw new Error("TINKER_CHROME_HOME must be an absolute path.");
    }
    return path.normalize(configured);
  }
  return path.join(os.homedir(), ".tinker", "chrome");
}

export function nativeHostConfigPath(home = tinkerChromeHome()): string {
  return path.join(home, "native-host-config.json");
}

export function nativeHostExecutablePath(home = tinkerChromeHome()): string {
  return path.join(home, "bin", "tinker-chrome-native-host");
}

export function nativeHostManifestPaths(): string[] {
  return [
    path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "NativeMessagingHosts",
      `${NATIVE_HOST_NAME}.json`,
    ),
    path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Google",
      "ChromeForTesting",
      "NativeMessagingHosts",
      `${NATIVE_HOST_NAME}.json`,
    ),
  ];
}

export async function installNativeHost(): Promise<NativeHostInstallation> {
  if (process.platform !== "darwin") {
    throw new Error("Tinker Chrome Native Host installation currently requires macOS.");
  }
  const home = tinkerChromeHome();
  const executablePath = nativeHostExecutablePath(home);
  const configPath = nativeHostConfigPath(home);
  const manifestPaths = nativeHostManifestPaths();
  await ensurePrivateDirectory(home);
  await ensurePrivateDirectory(path.dirname(executablePath));

  const cliPath = path.join(import.meta.dir, "cli.ts");
  const wrapper = [
    "#!/bin/sh",
    `exec ${shellQuote(process.execPath)} ${shellQuote(cliPath)} native-host "$@"`,
    "",
  ].join("\n");
  await atomicWrite(executablePath, wrapper, 0o700);

  const config: NativeHostConfigV1 = {
    schemaVersion: 1,
    nativeHostName: NATIVE_HOST_NAME,
    extensionOrigin: EXTENSION_ORIGIN,
    runtimeRoot: defaultRuntimeRoot(),
  };
  await atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`, 0o600);

  const manifest = {
    name: NATIVE_HOST_NAME,
    description: "Tinker Chrome bridge",
    path: executablePath,
    type: "stdio",
    allowed_origins: [EXTENSION_ORIGIN],
  };
  for (const manifestPath of manifestPaths) {
    await ensureOwnedManifest(manifestPath);
    await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  }

  return {
    home,
    executablePath,
    configPath,
    manifestPaths,
    extensionId: EXTENSION_ID,
  };
}

export async function loadNativeHostConfig(): Promise<NativeHostConfigV1> {
  const configPath = nativeHostConfigPath();
  let value: unknown;
  try {
    value = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Failed to read Native Host config at ${configPath}.`, {
      cause: error,
    });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Native Host config must be an object.");
  }
  const record = value as Record<string, unknown>;
  const keys = ["schemaVersion", "nativeHostName", "extensionOrigin", "runtimeRoot"];
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !(key in record))
  ) {
    throw new Error("Native Host config has missing or unknown fields.");
  }
  if (
    record.schemaVersion !== 1 ||
    record.nativeHostName !== NATIVE_HOST_NAME ||
    record.extensionOrigin !== EXTENSION_ORIGIN ||
    typeof record.runtimeRoot !== "string" ||
    !path.isAbsolute(record.runtimeRoot)
  ) {
    throw new Error("Native Host config does not match the installed v1 contract.");
  }
  const stat = await lstat(configPath);
  requireCurrentUser(stat.uid, configPath);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error("Native Host config must be a private regular file.");
  }
  return {
    schemaVersion: 1,
    nativeHostName: NATIVE_HOST_NAME,
    extensionOrigin: EXTENSION_ORIGIN,
    runtimeRoot: path.normalize(record.runtimeRoot),
  };
}

async function ensureOwnedManifest(manifestPath: string): Promise<void> {
  await mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  try {
    const stat = await lstat(manifestPath);
    requireCurrentUser(stat.uid, manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite non-file manifest ${manifestPath}.`);
    }
    const existing = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    if (
      typeof existing !== "object" ||
      existing === null ||
      !("name" in existing) ||
      existing.name !== NATIVE_HOST_NAME
    ) {
      throw new Error(
        `Refusing to overwrite manifest not owned by ${NATIVE_HOST_NAME}.`,
      );
    }
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}

async function atomicWrite(
  destination: string,
  content: string,
  mode: number,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.tmp`;
  await unlink(temporary).catch(ignoreMissing);
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode });
  try {
    await chmod(temporary, mode);
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  requireCurrentUser(stat.uid, directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${directory} must be a real directory.`);
  }
  await chmod(directory, 0o700);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function requireCurrentUser(uid: number, targetPath: string): void {
  const currentUid = process.getuid?.();
  if (currentUid === undefined || uid !== currentUid) {
    throw new Error(`${targetPath} is not owned by the current user.`);
  }
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
