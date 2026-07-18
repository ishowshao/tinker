import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { SLASH_COMMANDS, SlashCommandError, type SlashCommand } from "./slash-commands";

export const PROJECT_CONFIG_FILE_NAME = ".tinker.json";
export const PROJECT_CONFIG_MAX_BYTES = 1024 * 1024;

export type ProjectSlashCommand = SlashCommand & {
  readonly prompt: string;
};

const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BUILT_IN_NAMES = new Set(SLASH_COMMANDS.map((command) => command.name));

export async function loadProjectSlashCommands(
  workspaceRoot: string,
): Promise<readonly ProjectSlashCommand[]> {
  const canonicalRoot = await realpath(workspaceRoot);
  const configPath = path.join(canonicalRoot, PROJECT_CONFIG_FILE_NAME);
  let handle;

  try {
    handle = await open(configPath, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw loadError(configPath, error);
    }
    try {
      await lstat(configPath);
    } catch (lstatError) {
      if (isErrno(lstatError, "ENOENT")) {
        return [];
      }
      throw loadError(configPath, lstatError);
    }
    throw loadError(configPath, error);
  }

  try {
    const targetPath = await realpath(configPath);
    if (!isWithinWorkspace(canonicalRoot, targetPath)) {
      throw new Error(`${PROJECT_CONFIG_FILE_NAME} resolves outside the workspace.`);
    }

    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(`${PROJECT_CONFIG_FILE_NAME} must be a regular file.`);
    }
    const targetStats = await stat(targetPath);
    if (targetStats.dev !== stats.dev || targetStats.ino !== stats.ino) {
      throw new Error(`${PROJECT_CONFIG_FILE_NAME} changed while being opened.`);
    }
    if (stats.size > PROJECT_CONFIG_MAX_BYTES) {
      throw tooLargeError(stats.size);
    }

    const bytes = await readBounded(handle, PROJECT_CONFIG_MAX_BYTES);
    if (bytes.byteLength > PROJECT_CONFIG_MAX_BYTES) {
      throw tooLargeError(bytes.byteLength);
    }
    if (bytes.includes(0)) {
      throw new Error(`${PROJECT_CONFIG_FILE_NAME} contains a NUL byte.`);
    }

    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (error) {
      throw new Error(`${PROJECT_CONFIG_FILE_NAME} is not valid UTF-8.`, {
        cause: error,
      });
    }
    return parseProjectSlashCommands(raw, configPath);
  } catch (error) {
    throw loadError(configPath, error);
  } finally {
    await handle.close().catch((error: unknown) => {
      throw loadError(configPath, error);
    });
  }
}

export function parseProjectSlashCommands(
  raw: string,
  sourcePath: string,
): readonly ProjectSlashCommand[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON: ${errorMessage(error)}`, { cause: error });
  }

  const config = requireRecord(value, "configuration");
  requireExactKeys(config, ["version", "slashCommands"], "configuration");
  if (config.version !== 1) {
    throw new Error(`${sourcePath}: "version" must be 1.`);
  }
  if (!Array.isArray(config.slashCommands)) {
    throw new Error(`${sourcePath}: "slashCommands" must be an array.`);
  }

  const names = new Set<string>();
  return Object.freeze(
    config.slashCommands.map((entry, index) => {
      const where = `${sourcePath}: slashCommands[${index}]`;
      const command = requireRecord(entry, where);
      requireExactKeys(command, ["name", "description", "prompt"], where);
      const name = requireNonEmptyString(command.name, `${where}.name`);
      if (!COMMAND_NAME_PATTERN.test(name)) {
        throw new Error(`${where}.name must match ${COMMAND_NAME_PATTERN.toString()}.`);
      }
      if (BUILT_IN_NAMES.has(name)) {
        throw new Error(`${where}.name conflicts with built-in command /${name}.`);
      }
      if (names.has(name)) {
        throw new Error(`${where}.name duplicates /${name}.`);
      }
      names.add(name);

      return Object.freeze({
        name,
        description: requireNonEmptyString(command.description, `${where}.description`),
        prompt: requireNonEmptyString(command.prompt, `${where}.prompt`),
      });
    }),
  );
}

export function resolveProjectSlashCommand(
  input: string,
  commands: readonly ProjectSlashCommand[],
): ProjectSlashCommand | undefined {
  const trimmed = input.trim();
  const tokens = trimmed.split(/\s+/);
  const name = tokens[0]?.startsWith("/") ? tokens[0].slice(1) : "";
  const command = commands.find((candidate) => candidate.name === name);
  if (command === undefined) {
    return undefined;
  }
  if (tokens.length !== 1) {
    throw new SlashCommandError(`Usage: /${command.name}`);
  }
  return command;
}

async function readBounded(
  handle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(8192, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    if (bytesRead === 0) {
      break;
    }
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return Buffer.concat(chunks, total);
}

function requireRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  where: string,
): void {
  const expectedKeys = new Set(expected);
  const unknown = Object.keys(value).filter((key) => !expectedKeys.has(key));
  if (unknown.length > 0) {
    throw new Error(`${where} has unknown field ${JSON.stringify(unknown[0])}.`);
  }
  const missing = expected.find((key) => !(key in value));
  if (missing !== undefined) {
    throw new Error(`${where} is missing field ${JSON.stringify(missing)}.`);
  }
}

function requireNonEmptyString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${where} must be a non-empty string.`);
  }
  return value;
}

function isWithinWorkspace(workspaceRoot: string, targetPath: string): boolean {
  const relative = path.relative(workspaceRoot, targetPath);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function tooLargeError(actual: number): Error {
  return new Error(
    `${PROJECT_CONFIG_FILE_NAME} is ${actual} bytes; the limit is ${PROJECT_CONFIG_MAX_BYTES} bytes.`,
  );
}

function loadError(configPath: string, cause: unknown): Error {
  return new Error(
    `Failed to load project config ${configPath}: ${errorMessage(cause)}`,
    { cause },
  );
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
