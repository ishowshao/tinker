import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  publishRuntimeRegistry,
  removeRuntimeRegistry,
  runtimeDirectories,
  type RuntimeRegistryV1,
  runtimeSocketPath,
  scanRuntimeRegistries,
} from "../src/runtime-registry";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true });
  }
});

describe("Tinker Chrome runtime registry", () => {
  test("publishes, scans, and removes a live runtime", async () => {
    const root = await temporaryRoot();
    const directories = runtimeDirectories(root);
    const registry = createRegistry(directories, process.pid);

    await publishRuntimeRegistry(registry, directories);
    expect((await scanRuntimeRegistries({ root })).live).toEqual([registry]);

    await removeRuntimeRegistry(registry, directories);
    expect((await scanRuntimeRegistries({ root })).live).toEqual([]);
  });

  test("cleans only a validated stale registry", async () => {
    const root = await temporaryRoot();
    const directories = runtimeDirectories(root);
    const registry = createRegistry(directories, 2_147_483_647);
    await publishRuntimeRegistry(registry, directories);

    const scan = await scanRuntimeRegistries({ root, cleanupStale: true });
    expect(scan.live).toEqual([]);
    expect(scan.invalidEntries).toEqual([]);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tinker-chrome-registry-"));
  roots.push(root);
  return root;
}

function createRegistry(
  directories: ReturnType<typeof runtimeDirectories>,
  pid: number,
): RuntimeRegistryV1 {
  const runtimeId = randomUUID();
  return {
    schemaVersion: 1,
    protocolVersion: 2,
    runtimeId,
    pid,
    socketPath: runtimeSocketPath(runtimeId, directories),
    authToken: randomBytes(32).toString("base64url"),
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
  };
}
