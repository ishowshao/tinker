import { strict as assert } from "node:assert";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
  type SpawnSyncReturns,
} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

interface CommandResult {
  readonly error?: Error;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

const repositoryRoot = join(import.meta.dir, "..");
const packageJson = JSON.parse(
  readFileSync(join(repositoryRoot, "package.json"), "utf8"),
) as {
  name: string;
  version: string;
};
const temporaryRoot = mkdtempSync(join(tmpdir(), "tinker-release-"));

try {
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
    "src/cli/command-line.ts",
    "src/cli/index.ts",
    "src/cli/main.ts",
    "src/cli/package-metadata.ts",
    "src/cli/prompt-source.ts",
    "src/cli/public-cli-contract.ts",
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
      packedPaths.every((filePath) => !forbiddenPattern.test(filePath)),
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
    bin: Record<string, string>;
  };
  assert.equal(installedPackageJson.version, packageJson.version);
  assert.equal(installedPackageJson.license, "Apache-2.0");
  assert.deepEqual(installedPackageJson.bin, { tinker: "bin/tinker.js" });
  const installedBunPackageJson = JSON.parse(
    readFileSync(join(installedRoot, "node_modules", "bun", "package.json"), "utf8"),
  ) as { version: string };
  assert.equal(installedBunPackageJson.version, "1.3.14");
  const installedCommanderPackageJson = JSON.parse(
    readFileSync(
      join(installedRoot, "node_modules", "commander", "package.json"),
      "utf8",
    ),
  ) as { version: string };
  assert.equal(installedCommanderPackageJson.version, "15.0.0");
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

  const cleanEnvironment = cleanReleaseEnvironment(emptyHome);
  const rootHelp = await runInstalled(
    executable,
    ["--help"],
    cleanEnvironment,
    emptyWorkspace,
  );
  assert.equal(rootHelp.status, 0, commandFailure(executable, ["--help"], rootHelp));
  assert.match(rootHelp.stdout, /Usage: tinker \[options\] \[command\]/);
  assert.match(rootHelp.stdout, /--profile <profile-name>/);
  assert.equal(rootHelp.stderr, "");

  const version = await runInstalled(
    executable,
    ["--version"],
    cleanEnvironment,
    emptyWorkspace,
  );
  assert.equal(version.status, 0, commandFailure(executable, ["--version"], version));
  assert.equal(version.stdout, `${packageJson.version}\n`);
  assert.equal(version.stderr, "");

  const runHelp = await runInstalled(
    executable,
    ["help", "run"],
    cleanEnvironment,
    emptyWorkspace,
  );
  assert.equal(runHelp.status, 0, commandFailure(executable, ["help", "run"], runHelp));
  assert.match(runHelp.stdout, /--stdin/);
  assert.match(runHelp.stdout, /--file <path>/);
  assert.match(runHelp.stdout, /complex or sensitive prompts/);

  await assertUsageFailure(
    executable,
    ["--unknown"],
    cleanEnvironment,
    emptyWorkspace,
    2,
  );
  await assertUsageFailure(
    executable,
    ["run", "--stdin", "--stdin"],
    cleanEnvironment,
    emptyWorkspace,
    2,
  );
  await assertUsageFailure(
    executable,
    ["run", "--file", "--stdin"],
    cleanEnvironment,
    emptyWorkspace,
    2,
  );

  const configBeforeInput = await runInstalled(
    executable,
    ["run", "--stdin"],
    cleanEnvironment,
    emptyWorkspace,
    "unread prompt",
  );
  assert.equal(
    configBeforeInput.status,
    1,
    commandFailure(executable, ["run", "--stdin"], configBeforeInput),
  );
  assert.match(configBeforeInput.stderr, /TINKER_MODEL is required/);

  const offlineEnvironment: NodeJS.ProcessEnv = {
    ...cleanEnvironment,
    TINKER_MODEL: "release-smoke-model",
    TINKER_BASE_URL: "https://api.example.test/v1",
    TINKER_API_KEY: "release-placeholder-key",
    TINKER_CONTEXT_WINDOW_TOKENS: String(128 * 1_024),
    TINKER_MAX_SUPPORTED_OUTPUT_TOKENS: String(16 * 1_024),
    TINKER_TEST_FAKE_MODEL: "release-smoke",
    TINKER_WORKSPACE: emptyWorkspace,
  };
  const argumentText = "release argument `$HOME` *.ts";
  await assertFakePrompt(
    executable,
    ["run", argumentText],
    offlineEnvironment,
    emptyWorkspace,
    argumentText,
  );
  const stdinText = "release stdin\nsecond line\n";
  await assertFakePrompt(
    executable,
    ["run", "--stdin"],
    offlineEnvironment,
    emptyWorkspace,
    stdinText,
    stdinText,
  );
  const promptFile = join(temporaryRoot, "prompt.md");
  const fileText = "release file\r\nsecond line\n";
  writeFileSync(promptFile, fileText);
  await assertFakePrompt(
    executable,
    ["run", "--file", promptFile],
    offlineEnvironment,
    emptyWorkspace,
    fileText,
  );

  const profilesPath = join(temporaryRoot, "models.json");
  writeFileSync(
    profilesPath,
    JSON.stringify({
      default: "release",
      profiles: {
        release: {
          model: "release-profile-model",
          apiBase: "https://api.example.test/v1",
          apiKey: "release-placeholder-key",
          contextWindowTokens: 128 * 1_024,
          maxSupportedOutputTokens: 16 * 1_024,
        },
      },
    }),
  );
  const profileEnvironment: NodeJS.ProcessEnv = {
    ...cleanEnvironment,
    TINKER_MODELS: profilesPath,
    TINKER_TEST_FAKE_MODEL: "release-smoke",
    TINKER_WORKSPACE: emptyWorkspace,
  };
  await assertFakePrompt(
    executable,
    ["run", "--profile", "release", "release profile"],
    profileEnvironment,
    emptyWorkspace,
    "release profile",
  );

  process.stdout.write(
    `Verified ${packed.id}: npm tarball, clean global prefix, bundled Bun and ripgrep, CLI help/version/errors, and argument/stdin/file Prompt sources on ${process.platform}.\n`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true });
}

function cleanReleaseEnvironment(emptyHome: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("TINKER_") || name === "EXA_API_KEY") {
      delete environment[name];
    }
  }
  environment.HOME = emptyHome;
  const nodeExecutable = run("node", ["-p", "process.execPath"]).stdout.trim();
  assert(nodeExecutable !== "", "could not locate the Node.js executable");
  environment.PATH = `${dirname(nodeExecutable)}:/usr/bin:/bin`;
  return environment;
}

async function assertUsageFailure(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  expectedStatus: number,
): Promise<void> {
  const result = await runInstalled(executable, args, env, cwd);
  assert.equal(result.status, expectedStatus, commandFailure(executable, args, result));
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^error: /);
  assert.match(result.stderr, /Run "tinker(?: run)? --help" for usage\.\n$/);
}

async function assertFakePrompt(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  expectedPrompt: string,
  stdin?: string,
): Promise<void> {
  const result = await runInstalled(executable, args, env, cwd, stdin);
  assert.equal(result.status, 0, commandFailure(executable, args, result));
  assert.equal(result.stderr, "");
  assert(
    result.stdout.includes(`Fake model received: ${expectedPrompt}`),
    `one-shot output did not preserve the expected Prompt for ${args.join(" ")}`,
  );
}

function runInstalled(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  input?: string,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, args, {
        cwd,
        env,
        stdio: "pipe",
      });
    } catch (error) {
      resolve({
        error: asError(error),
        status: null,
        signal: null,
        stdout: "",
        stderr: "",
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ error, status: null, signal: null, stdout, stderr });
    });
    child.once("close", (status, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ status, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function run(command: string, args: string[]): SpawnSyncReturns<string> {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(commandFailure(command, args, result));
  }
  return result;
}

function commandFailure(
  command: string,
  args: string[],
  result: Pick<CommandResult, "error" | "status" | "stdout" | "stderr">,
): string {
  return [
    `${command} ${args.join(" ")} failed with status ${String(result.status)}`,
    `stdout: ${boundedDiagnostic(result.stdout)}`,
    `stderr: ${boundedDiagnostic(result.stderr)}`,
    ...(result.error === undefined ? [] : [`spawn error: ${result.error.name}`]),
  ].join("\n");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function boundedDiagnostic(value: string): string {
  const escaped = JSON.stringify(
    value.replaceAll(/release-placeholder-key/g, "[redacted]"),
  );
  return escaped.length <= 2_000 ? escaped : `${escaped.slice(0, 1_980)}...[truncated]`;
}
