#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

let bunPackageJson;
try {
  bunPackageJson = require.resolve("bun/package.json");
} catch {
  process.stderr.write(
    "Tinker could not find its bundled Bun runtime. Reinstall tinker-agent.\n",
  );
  process.exit(1);
}

const bunExecutable = join(dirname(bunPackageJson), "bin", "bun.exe");
const tinkerEntryPoint = fileURLToPath(
  new URL("../src/cli/index.ts", import.meta.url),
);
const result = spawnSync(
  bunExecutable,
  [tinkerEntryPoint, ...process.argv.slice(2)],
  { stdio: "inherit" },
);

if (result.error !== undefined) {
  process.stderr.write(`Tinker failed to start Bun: ${result.error.message}\n`);
  process.exit(1);
}

if (result.signal !== null) {
  process.kill(process.pid, result.signal);
}

process.exit(result.status ?? 1);
