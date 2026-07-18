import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  SKILL_RESOURCE_MAX_DEPTH,
  SKILL_RESOURCE_MAX_ENTRIES,
  SkillError,
  type LoadedSkill,
  type SkillCatalogSnapshot,
} from "./skill-loader";
import { createSkillToolDefinition } from "./skill-catalog";
import type { SkillActivationCoordinator } from "./skill-context";
import { defineToolExecutor, type ToolExecutor } from "../tools/types";
import { cancellationError, throwIfTurnCancelled } from "../agent/turn-cancellation";

export function createSkillToolExecutor(input: {
  catalog: SkillCatalogSnapshot;
  coordinator: SkillActivationCoordinator;
}): ToolExecutor {
  return defineToolExecutor("skill", {
    definition: createSkillToolDefinition(input.catalog),
    async execute(args, _call, context) {
      throwIfTurnCancelled(context.signal);
      let name: string;
      try {
        name = parseSkillArgs(args);
      } catch (error) {
        return failed(
          "",
          error instanceof SkillError ? error.code : "SKILL_FIELD_INVALID",
          errorMessage(error),
        );
      }
      const skill = input.catalog.skills.get(name);
      if (skill === undefined) {
        return failed(name, "SKILL_NOT_FOUND", `Unknown Agent Skill: ${name}.`);
      }
      const status = input.coordinator.status(name);
      if (status.status === "active") {
        return {
          ok: true,
          status: "already_active",
          name,
          scope: status.skill.scope,
          sha256: status.skill.sha256,
        };
      }
      if (status.status === "loaded") {
        return {
          ok: true,
          status: "already_loaded",
          name,
          scope: status.skill.scope,
          lifecycle: status.lifecycle,
          sha256: status.skill.sha256,
        };
      }

      try {
        input.coordinator.reserve(skill);
        const resources = await listSkillResources(skill, context.signal);
        throwIfTurnCancelled(context.signal);
        return {
          ok: true,
          status: "loaded",
          name,
          scope: skill.scope,
          directory: skill.directory,
          skillFilePath: skill.skillFilePath,
          content: skill.content,
          byteLength: skill.byteLength,
          sha256: skill.sha256,
          resources: resources.paths,
          resourcesTruncated: resources.truncated,
        };
      } catch (error) {
        input.coordinator.release(name);
        if (context.signal.aborted) {
          throw cancellationError(context.signal, error);
        }
        const code =
          error instanceof SkillError ? error.code : "SKILL_RESOURCE_INVALID";
        return failed(name, code, errorMessage(error));
      }
    },
  });
}

function parseSkillArgs(args: unknown): string {
  if (
    typeof args !== "object" ||
    args === null ||
    Array.isArray(args) ||
    Object.keys(args).length !== 1 ||
    typeof (args as Record<string, unknown>).name !== "string" ||
    (args as Record<string, string>).name.trim() === ""
  ) {
    throw new SkillError(
      "SKILL_FIELD_INVALID",
      "Skill arguments must be exactly { name: <available-skill-name> }.",
    );
  }
  return (args as { name: string }).name;
}

async function listSkillResources(
  skill: LoadedSkill,
  signal: AbortSignal,
): Promise<{
  paths: readonly string[];
  truncated: boolean;
}> {
  const files: string[] = [];
  let depthTruncated = false;
  for (const rootName of ["assets", "references", "scripts"] as const) {
    throwIfTurnCancelled(signal);
    if (files.length > SKILL_RESOURCE_MAX_ENTRIES) {
      break;
    }
    const logicalRoot = path.join(skill.directory, rootName);
    let rootStats;
    try {
      rootStats = await lstat(logicalRoot);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        continue;
      }
      throw resourceError(skill, rootName, error);
    }
    const canonicalRoot = await resolveResourcePath(skill, logicalRoot, rootName);
    const targetStats = await stat(canonicalRoot);
    if (!targetStats.isDirectory()) {
      if (rootStats.isSymbolicLink()) {
        throw resourceError(
          skill,
          rootName,
          "resource root symlink is not a directory",
        );
      }
      continue;
    }
    await walkResources({
      skill,
      logicalDirectory: logicalRoot,
      logicalRelative: rootName,
      depth: 1,
      canonicalAncestors: new Set([canonicalRoot]),
      files,
      signal,
      onDepthTruncated: () => {
        depthTruncated = true;
      },
    });
  }
  files.sort(compareText);
  const truncated = depthTruncated || files.length > SKILL_RESOURCE_MAX_ENTRIES;
  return {
    paths: Object.freeze(files.slice(0, SKILL_RESOURCE_MAX_ENTRIES)),
    truncated,
  };
}

async function walkResources(input: {
  skill: LoadedSkill;
  logicalDirectory: string;
  logicalRelative: string;
  depth: number;
  canonicalAncestors: ReadonlySet<string>;
  files: string[];
  signal: AbortSignal;
  onDepthTruncated(): void;
}): Promise<void> {
  throwIfTurnCancelled(input.signal);
  let entries;
  try {
    entries = await readdir(input.logicalDirectory, { withFileTypes: true });
  } catch (error) {
    throw resourceError(input.skill, input.logicalRelative, error);
  }
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    throwIfTurnCancelled(input.signal);
    if (input.files.length > SKILL_RESOURCE_MAX_ENTRIES) {
      return;
    }
    const logicalPath = path.join(input.logicalDirectory, entry.name);
    const relativePath = `${input.logicalRelative}/${entry.name}`;
    const canonicalPath = await resolveResourcePath(
      input.skill,
      logicalPath,
      relativePath,
    );
    const targetStats = await stat(canonicalPath);
    if (targetStats.isFile()) {
      input.files.push(relativePath.split(path.sep).join("/"));
      continue;
    }
    if (!targetStats.isDirectory()) {
      throw resourceError(
        input.skill,
        relativePath,
        "resource must resolve to a regular file or directory",
      );
    }
    if (input.depth >= SKILL_RESOURCE_MAX_DEPTH) {
      input.onDepthTruncated();
      continue;
    }
    if (input.canonicalAncestors.has(canonicalPath)) {
      throw resourceError(input.skill, relativePath, "resource symlink cycle detected");
    }
    await walkResources({
      ...input,
      logicalDirectory: logicalPath,
      logicalRelative: relativePath,
      depth: input.depth + 1,
      canonicalAncestors: new Set([...input.canonicalAncestors, canonicalPath]),
    });
    if (input.files.length > SKILL_RESOURCE_MAX_ENTRIES) {
      return;
    }
  }
}

async function resolveResourcePath(
  skill: LoadedSkill,
  logicalPath: string,
  relativePath: string,
): Promise<string> {
  try {
    const canonical = await realpath(logicalPath);
    if (!isWithin(skill.directory, canonical)) {
      throw resourceError(
        skill,
        relativePath,
        "resource resolves outside the skill directory",
      );
    }
    return canonical;
  } catch (error) {
    if (error instanceof SkillError) {
      throw error;
    }
    throw resourceError(skill, relativePath, error);
  }
}

function failed(
  name: string,
  errorCode: string,
  error: string,
): {
  ok: false;
  status: "failed";
  name: string;
  errorCode: string;
  error: string;
} {
  return { ok: false, status: "failed", name, errorCode, error };
}

function resourceError(
  skill: LoadedSkill,
  relativePath: string,
  cause: unknown,
): SkillError {
  return new SkillError(
    "SKILL_RESOURCE_INVALID",
    `Agent Skill ${skill.scope}/${skill.name} resource ${relativePath} is invalid: ${errorMessage(cause)}.`,
    { cause },
  );
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
