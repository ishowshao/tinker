#!/usr/bin/env node

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const START_FAILURE_MESSAGE =
  "Tinker failed to start. Reinstall tinker-agent.\n";

export async function launchTinker(
  input = {
    args: process.argv.slice(2),
    stderr: process.stderr,
  },
  injected = {},
) {
  const resolveBundledBun =
    injected.resolveBundledBun ?? (() => require.resolve("bun/package.json"));
  const startChild = injected.spawn ?? spawn;
  const forwardSignal =
    injected.forwardSignal ?? ((signal) => process.kill(process.pid, signal));

  let bunPackageJson;
  try {
    bunPackageJson = resolveBundledBun();
  } catch {
    input.stderr.write(START_FAILURE_MESSAGE);
    return 1;
  }

  const bunExecutable = join(dirname(bunPackageJson), "bin", "bun.exe");
  const tinkerEntryPoint = fileURLToPath(
    new URL("../src/cli/index.ts", import.meta.url),
  );
  let child;
  try {
    child = startChild(
      bunExecutable,
      [tinkerEntryPoint, ...input.args],
      { stdio: "inherit" },
    );
  } catch {
    input.stderr.write(START_FAILURE_MESSAGE);
    return 1;
  }

  return new Promise((resolve) => {
    let settled = false;
    child.once("error", () => {
      if (settled) {
        return;
      }
      settled = true;
      input.stderr.write(START_FAILURE_MESSAGE);
      resolve(1);
    });
    child.once("exit", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      if (signal !== null) {
        forwardSignal(signal);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function isExecutableEntryPoint() {
  const entryPoint = process.argv[1];
  if (entryPoint === undefined) {
    return false;
  }
  try {
    return realpathSync(entryPoint) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isExecutableEntryPoint()) {
  process.exitCode = await launchTinker();
}
