import { access, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { EXTENSION_ID, EXTENSION_ORIGIN, NATIVE_HOST_NAME } from "./constants";
import { extensionBuildRoot } from "./extension-path";
import {
  loadNativeHostConfig,
  nativeHostConfigPath,
  nativeHostExecutablePath,
  nativeHostManifestPaths,
} from "./install-host";
import { defaultRuntimeRoot, scanRuntimeRegistries } from "./runtime-registry";

export type ChromeDiagnosis = {
  ok: boolean;
  extension: {
    id: string;
    buildPath: string;
    built: boolean;
  };
  nativeHost: {
    configPath: string;
    executablePath: string;
    manifests: Array<{ path: string; valid: boolean; error?: string }>;
    valid: boolean;
    error?: string;
  };
  runtime: {
    root: string;
    liveCount: number;
    invalidCount: number;
  };
};

export async function diagnoseChromeBridge(): Promise<ChromeDiagnosis> {
  const buildPath = extensionBuildRoot();
  const built = await pathExists(path.join(buildPath, "manifest.json"));
  const configPath = nativeHostConfigPath();
  const executablePath = nativeHostExecutablePath();
  let nativeHostValid = false;
  let nativeHostError: string | undefined;
  try {
    const config = await loadNativeHostConfig();
    const executable = await lstat(executablePath);
    if (!executable.isFile() || (executable.mode & 0o100) === 0) {
      throw new Error("Native Host executable is missing or not executable.");
    }
    if (
      config.nativeHostName !== NATIVE_HOST_NAME ||
      config.extensionOrigin !== EXTENSION_ORIGIN
    ) {
      throw new Error("Native Host config does not match the extension.");
    }
    nativeHostValid = true;
  } catch (error) {
    nativeHostError = error instanceof Error ? error.message : String(error);
  }

  const manifests = await Promise.all(
    nativeHostManifestPaths().map(async (manifestPath) => {
      try {
        const value = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
        if (
          typeof value !== "object" ||
          value === null ||
          !("name" in value) ||
          value.name !== NATIVE_HOST_NAME ||
          !("path" in value) ||
          value.path !== executablePath ||
          !("allowed_origins" in value) ||
          !Array.isArray(value.allowed_origins) ||
          value.allowed_origins.length !== 1 ||
          value.allowed_origins[0] !== EXTENSION_ORIGIN
        ) {
          throw new Error("Manifest does not match the Tinker Chrome contract.");
        }
        return { path: manifestPath, valid: true };
      } catch (error) {
        return {
          path: manifestPath,
          valid: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  const runtimeRoot = defaultRuntimeRoot();
  const runtime = await scanRuntimeRegistries({ root: runtimeRoot });
  const ok =
    built &&
    nativeHostValid &&
    manifests.every((manifest) => manifest.valid) &&
    runtime.invalidEntries.length === 0;

  return {
    ok,
    extension: { id: EXTENSION_ID, buildPath, built },
    nativeHost: {
      configPath,
      executablePath,
      manifests,
      valid: nativeHostValid,
      ...(nativeHostError === undefined ? {} : { error: nativeHostError }),
    },
    runtime: {
      root: runtimeRoot,
      liveCount: runtime.live.length,
      invalidCount: runtime.invalidEntries.length,
    },
  };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}
