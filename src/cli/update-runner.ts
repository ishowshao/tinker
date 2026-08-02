import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPackageMetadata, type PackageMetadata } from "./package-metadata";
import { writeCliOutput, type CliOutputWriter } from "./output";

export const OFFICIAL_NPM_REGISTRY = "https://registry.npmjs.org/";

const OFFICIAL_PACKAGE_NAME = "tinker-agent";
const MAX_NPM_OUTPUT_CHARACTERS = 32_768;

type NpmCommandResult = {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
};

type NpmCommandInput = {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
};

export type UpdateRunnerDependencies = {
  readonly packageRoot: string;
  readonly npmCwd: string;
  readonly runNpm: (input: NpmCommandInput) => Promise<NpmCommandResult>;
  readonly canonicalizePath: (filePath: string) => Promise<string>;
  readonly isSymbolicLink: (filePath: string) => Promise<boolean>;
  readonly readPackageMetadata: (packageJsonPath: string) => Promise<PackageMetadata>;
  readonly compareVersions: (left: string, right: string) => -1 | 0 | 1;
};

type UpdateInput = {
  readonly metadata: PackageMetadata;
  readonly stdout: CliOutputWriter;
  readonly env: NodeJS.ProcessEnv;
};

const DEFAULT_DEPENDENCIES: UpdateRunnerDependencies = {
  packageRoot: path.resolve(fileURLToPath(new URL("../../", import.meta.url))),
  npmCwd: tmpdir(),
  runNpm,
  canonicalizePath: realpath,
  isSymbolicLink: async (filePath) => (await lstat(filePath)).isSymbolicLink(),
  readPackageMetadata: (packageJsonPath) =>
    loadPackageMetadata(pathToFileURL(packageJsonPath)),
  compareVersions: (left, right) => Bun.semver.order(left, right),
};

export async function runUpdate(
  input: UpdateInput,
  injected: Partial<UpdateRunnerDependencies> = {},
): Promise<number> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...injected };
  if (input.metadata.name !== OFFICIAL_PACKAGE_NAME) {
    throw new Error("The installed package is not tinker-agent.");
  }

  await writeCliOutput(input.stdout, `Current version: ${input.metadata.version}\n`);
  await writeCliOutput(
    input.stdout,
    "Checking npm official registry for the latest version...\n",
  );

  const globalRoot = await readGlobalPath(
    dependencies,
    input.env,
    ["root", "--global"],
    "npm global package root",
  );
  const globalPrefix = await readGlobalPath(
    dependencies,
    input.env,
    ["prefix", "--global"],
    "npm global prefix",
  );
  const installedRoot = path.join(globalRoot, input.metadata.name);
  await assertGlobalInstallation(dependencies, installedRoot);

  const latestResult = await runNpmChecked(
    dependencies,
    {
      args: [
        "view",
        `${input.metadata.name}@latest`,
        "version",
        "--json",
        "--registry",
        OFFICIAL_NPM_REGISTRY,
        "--prefer-online",
      ],
      cwd: dependencies.npmCwd,
      env: input.env,
    },
    "Could not query the npm official registry",
  );
  const latestVersion = parseLatestVersion(latestResult.stdout);
  const order = compareVersions(dependencies, input.metadata.version, latestVersion);

  if (order === 0) {
    await writeCliOutput(
      input.stdout,
      `Already up to date: ${input.metadata.version}\n`,
    );
    return 0;
  }
  if (order > 0) {
    await writeCliOutput(
      input.stdout,
      `Installed version ${input.metadata.version} is newer than npm latest ${latestVersion}; no changes made.\n`,
    );
    return 0;
  }

  await writeCliOutput(input.stdout, `Updating to ${latestVersion}...\n`);
  await runNpmChecked(
    dependencies,
    {
      args: [
        "install",
        "--global",
        "--prefix",
        globalPrefix,
        `${input.metadata.name}@${latestVersion}`,
        "--registry",
        OFFICIAL_NPM_REGISTRY,
        "--prefer-online",
        "--no-audit",
        "--no-fund",
        "--loglevel",
        "error",
      ],
      cwd: dependencies.npmCwd,
      env: input.env,
    },
    `npm could not install ${input.metadata.name}@${latestVersion}`,
  );

  let installedMetadata: PackageMetadata;
  try {
    installedMetadata = await dependencies.readPackageMetadata(
      path.join(installedRoot, "package.json"),
    );
  } catch {
    throw new Error("The updated package metadata could not be verified.");
  }
  if (
    installedMetadata.name !== input.metadata.name ||
    installedMetadata.version !== latestVersion
  ) {
    throw new Error(
      `npm completed, but the active global installation is not version ${latestVersion}.`,
    );
  }

  await writeCliOutput(
    input.stdout,
    `Successfully updated from ${input.metadata.version} to version ${latestVersion}\n`,
  );
  return 0;
}

async function readGlobalPath(
  dependencies: UpdateRunnerDependencies,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  label: string,
): Promise<string> {
  const result = await runNpmChecked(
    dependencies,
    { args, cwd: dependencies.npmCwd, env },
    `Could not resolve the ${label}`,
  );
  const value = result.stdout.trim();
  if (value === "" || !path.isAbsolute(value)) {
    throw new Error(`npm returned an invalid ${label}.`);
  }
  return value;
}

async function assertGlobalInstallation(
  dependencies: UpdateRunnerDependencies,
  installedRoot: string,
): Promise<void> {
  try {
    const [packageRoot, expectedRoot, linked] = await Promise.all([
      dependencies.canonicalizePath(dependencies.packageRoot),
      dependencies.canonicalizePath(installedRoot),
      dependencies.isSymbolicLink(installedRoot),
    ]);
    if (linked || packageRoot !== expectedRoot) {
      throw new Error("not a direct global installation");
    }
  } catch {
    throw new Error(
      "This Tinker installation is not managed by the active npm global prefix.",
    );
  }
}

function parseLatestVersion(stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("npm returned invalid update metadata.");
  }
  if (typeof parsed !== "string" || parsed.trim() === "") {
    throw new Error("npm returned invalid update metadata.");
  }
  return parsed.trim();
}

function compareVersions(
  dependencies: UpdateRunnerDependencies,
  currentVersion: string,
  latestVersion: string,
): -1 | 0 | 1 {
  try {
    return dependencies.compareVersions(currentVersion, latestVersion);
  } catch {
    throw new Error("Tinker or npm returned an invalid semantic version.");
  }
}

async function runNpmChecked(
  dependencies: UpdateRunnerDependencies,
  input: NpmCommandInput,
  failureMessage: string,
): Promise<NpmCommandResult> {
  const result = await dependencies.runNpm(input);
  if (result.exitCode === 0) {
    return result;
  }
  const diagnostic = result.stderr.trim() || result.stdout.trim();
  const status =
    result.signal === null
      ? `npm exited with code ${String(result.exitCode)}`
      : `npm exited after ${result.signal}`;
  throw new Error(
    diagnostic === ""
      ? `${failureMessage}: ${status}.`
      : `${failureMessage}: ${diagnostic}`,
  );
}

function runNpm(input: NpmCommandInput): Promise<NpmCommandResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("npm", [...input.args], {
        cwd: input.cwd,
        env: {
          ...input.env,
          NPM_CONFIG_UPDATE_NOTIFIER: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      reject(new Error("npm could not be started."));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      const code = (error as NodeJS.ErrnoException).code;
      reject(
        new Error(
          code === "ENOENT"
            ? "npm was not found on PATH."
            : "npm could not be started.",
        ),
      );
    });
    child.once("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}

function appendBounded(current: string, chunk: string): string {
  if (current.length >= MAX_NPM_OUTPUT_CHARACTERS) {
    return current;
  }
  return (current + chunk).slice(0, MAX_NPM_OUTPUT_CHARACTERS);
}
