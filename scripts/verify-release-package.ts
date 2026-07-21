import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

interface PackFile {
  path: string;
}

interface PackResult {
  id: string;
  name: string;
  version: string;
  filename: string;
  files: PackFile[];
}

const repositoryRoot = join(import.meta.dir, "..");
const packageJson = JSON.parse(
  readFileSync(join(repositoryRoot, "package.json"), "utf8"),
) as {
  name: string;
  version: string;
};
const temporaryRoot = mkdtempSync(join(tmpdir(), "tinker-release-"));
const packageDirectory = join(temporaryRoot, "package");
const installPrefix = join(temporaryRoot, "install");
const emptyHome = join(temporaryRoot, "home");
const emptyWorkspace = join(temporaryRoot, "workspace");
mkdirSync(packageDirectory);
mkdirSync(installPrefix);
mkdirSync(emptyHome);
mkdirSync(emptyWorkspace);

const pack = run("npm", ["pack", "--json", "--pack-destination", packageDirectory]);
const packResults = JSON.parse(pack.stdout) as PackResult[];
assert.equal(packResults.length, 1, "npm pack must produce exactly one package");
const [packed] = packResults;
assert(packed !== undefined);
assert.equal(packed.name, packageJson.name);
assert.equal(packed.version, packageJson.version);
assert.equal(packed.id, `${packageJson.name}@${packageJson.version}`);

const packedPaths = packed.files.map((file) => file.path);
for (const requiredPath of [
  "LICENSE",
  "NOTICE",
  "README.md",
  "bin/tinker.js",
  "package.json",
  "src/cli/index.ts",
]) {
  assert(packedPaths.includes(requiredPath), `package is missing ${requiredPath}`);
}
for (const forbiddenPattern of [
  /^\.env/,
  /^\.github\//,
  /^\.tinker\//,
  /^docs\//,
  /^src\/__tests__\//,
]) {
  assert(
    packedPaths.every((path) => !forbiddenPattern.test(path)),
    `package contains a forbidden path matching ${forbiddenPattern}`,
  );
}

const tarballPath = join(packageDirectory, packed.filename);
run("npm", ["install", "--global", "--prefix", installPrefix, tarballPath]);

const executable = join(installPrefix, "bin", "tinker");
assert(existsSync(executable), "global installation did not expose tinker");
assert(
  !existsSync(join(installPrefix, "bin", "tinker-agent")),
  "global installation exposed an unexpected tinker-agent command",
);

const installedRoot = join(installPrefix, "lib", "node_modules", "tinker-agent");
const installedPackageJson = JSON.parse(
  readFileSync(join(installedRoot, "package.json"), "utf8"),
) as {
  version: string;
  license: string;
};
assert.equal(installedPackageJson.version, packageJson.version);
assert.equal(installedPackageJson.license, "Apache-2.0");
const installedBunPackageJson = JSON.parse(
  readFileSync(join(installedRoot, "node_modules", "bun", "package.json"), "utf8"),
) as { version: string };
assert.equal(installedBunPackageJson.version, "1.3.14");
const installedRipgrepPackageJson = JSON.parse(
  readFileSync(
    join(installedRoot, "node_modules", "@vscode", "ripgrep", "package.json"),
    "utf8",
  ),
) as { version: string };
assert.equal(installedRipgrepPackageJson.version, "1.18.0");
assert(
  readFileSync(
    join(installedRoot, "node_modules", "markdansi", "dist", "render.js"),
    "utf8",
  ).includes("hardWrapTableCellLine"),
  "installed package lost the bundled markdansi patch",
);

const cleanEnvironment = { ...process.env };
for (const name of Object.keys(cleanEnvironment)) {
  if (name.startsWith("TINKER_") || name === "EXA_API_KEY") {
    delete cleanEnvironment[name];
  }
}
cleanEnvironment.HOME = emptyHome;
const nodeExecutable = run("node", ["-p", "process.execPath"]).stdout.trim();
assert(nodeExecutable !== "", "could not locate the Node.js executable");
cleanEnvironment.PATH = `${dirname(nodeExecutable)}:/usr/bin:/bin`;

const smoke = spawnSync(executable, ["run", "release smoke"], {
  cwd: emptyWorkspace,
  encoding: "utf8",
  env: cleanEnvironment,
});
assert.equal(smoke.status, 1, smoke.stderr);
assert.match(smoke.stderr, /TINKER_MODEL is required/);

process.stdout.write(
  `Verified ${packed.id}: npm tarball, bundled Bun and ripgrep, tinker launcher, license, and dependency patch.\n`,
);

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}):\n${result.stderr}`,
    );
  }
  return result;
}
