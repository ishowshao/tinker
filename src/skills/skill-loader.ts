import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isAlias, isMap, isScalar, parseDocument, visit } from "yaml";
import { immutableRecord } from "../context/protocol-frame";
import { createSkillCatalogSnapshot } from "./skill-catalog";

export const SKILL_FILE_MAX_BYTES = 64 * 1024;
export const SKILL_COUNT_MAX = 128;
export const SKILL_CATALOG_MAX_BYTES = 64 * 1024;
export const SKILL_RESOURCE_MAX_DEPTH = 4;
export const SKILL_RESOURCE_MAX_ENTRIES = 200;
export const ACTIVE_SKILL_COUNT_MAX = 16;
export const ACTIVE_SKILL_TOTAL_BYTES_MAX = 128 * 1024;

export type SkillScope = "project" | "user";

export type LoadedSkill = {
  readonly name: string;
  readonly description: string;
  readonly scope: SkillScope;
  readonly directory: string;
  readonly skillFilePath: string;
  readonly content: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly frontmatter: {
    readonly license?: string;
    readonly compatibility?: string;
    readonly metadata?: Readonly<Record<string, string>>;
    readonly allowedTools?: string;
  };
};

export type SkillShadow = {
  readonly name: string;
  readonly winner: SkillScope;
  readonly loser: SkillScope;
};

export type SkillCatalogSnapshot = {
  readonly workspaceRoot: string;
  readonly homeRoot: string;
  readonly skills: ReadonlyMap<string, LoadedSkill>;
  readonly shadowed: readonly SkillShadow[];
  readonly manifestSha256: string;
};

export type SkillErrorCode =
  | "SKILL_ROOT_INVALID"
  | "SKILL_PATH_OUTSIDE_SCOPE"
  | "SKILL_FILE_NOT_REGULAR"
  | "SKILL_FILE_TOO_LARGE"
  | "SKILL_FILE_NOT_UTF8"
  | "SKILL_FRONTMATTER_INVALID"
  | "SKILL_FIELD_INVALID"
  | "SKILL_NAME_MISMATCH"
  | "SKILL_BODY_EMPTY"
  | "SKILL_COUNT_EXCEEDED"
  | "SKILL_CATALOG_TOO_LARGE"
  | "SKILL_RESOURCE_INVALID"
  | "SKILL_NOT_FOUND"
  | "SKILL_ACTIVE_LIMIT_EXCEEDED"
  | "SKILL_ACTIVATION_STATE_INVALID"
  | "SKILL_DISPATCH_COMMIT_FAILED"
  | "SKILLS_UPDATE_STALE"
  | "SKILLS_UPDATE_VALIDATION_FAILED";

export class SkillError extends Error {
  constructor(
    readonly code: SkillErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SkillError";
  }
}

type ScopeRoot = {
  scope: SkillScope;
  trustRoot: string;
  configuredRoot: string;
  canonicalRoot: string;
};

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function loadSkillCatalog(input: {
  workspaceRoot: string;
  homeRoot?: string;
}): Promise<SkillCatalogSnapshot> {
  const workspaceRoot = await canonicalDirectory(input.workspaceRoot, "workspace");
  const homeRoot = await canonicalDirectory(input.homeRoot ?? os.homedir(), "home");
  const configured = [
    {
      scope: "project" as const,
      trustRoot: workspaceRoot,
      root: path.join(workspaceRoot, ".agents", "skills"),
    },
    {
      scope: "user" as const,
      trustRoot: homeRoot,
      root: path.join(homeRoot, ".agents", "skills"),
    },
  ];
  const roots: ScopeRoot[] = [];
  for (const entry of configured) {
    const root = await resolveScopeRoot(entry.scope, entry.trustRoot, entry.root);
    if (root === undefined) {
      continue;
    }
    const existing = roots.find(
      (candidate) => candidate.canonicalRoot === root.canonicalRoot,
    );
    if (existing !== undefined) {
      if (entry.scope === "project") {
        existing.scope = "project";
        existing.trustRoot = workspaceRoot;
        existing.configuredRoot = entry.root;
      }
      continue;
    }
    roots.push(root);
  }

  const candidates: LoadedSkill[] = [];
  for (const root of roots.sort(
    (left, right) => scopeOrder(left.scope) - scopeOrder(right.scope),
  )) {
    candidates.push(...(await loadScopeCandidates(root, candidates.length)));
  }

  const byName = new Map<string, LoadedSkill>();
  const shadowed: SkillShadow[] = [];
  for (const skill of candidates
    .filter((candidate) => candidate.scope === "user")
    .sort(compareSkills)) {
    if (byName.has(skill.name)) {
      throw new SkillError(
        "SKILL_ACTIVATION_STATE_INVALID",
        `Loader invariant failed: duplicate ${skill.scope} skill ${skill.name}.`,
      );
    }
    byName.set(skill.name, skill);
  }
  for (const skill of candidates
    .filter((candidate) => candidate.scope === "project")
    .sort(compareSkills)) {
    const previous = byName.get(skill.name);
    if (previous?.scope === "project") {
      throw new SkillError(
        "SKILL_ACTIVATION_STATE_INVALID",
        `Loader invariant failed: duplicate project skill ${skill.name}.`,
      );
    }
    if (previous !== undefined) {
      shadowed.push(
        immutableRecord({
          name: skill.name,
          winner: "project" as const,
          loser: "user" as const,
        }),
      );
    }
    byName.set(skill.name, skill);
  }

  return createSkillCatalogSnapshot({
    workspaceRoot,
    homeRoot,
    skills: [...byName.values()].sort(compareSkills),
    shadowed: shadowed.sort((left, right) => compareText(left.name, right.name)),
  });
}

async function canonicalDirectory(value: string, label: string): Promise<string> {
  if (!path.isAbsolute(value)) {
    throw new SkillError(
      "SKILL_ROOT_INVALID",
      `Agent Skills ${label} root must be an absolute path: ${value}.`,
    );
  }
  try {
    const canonical = await realpath(value);
    const stats = await stat(canonical);
    if (!stats.isDirectory()) {
      throw new Error("not a directory");
    }
    return canonical;
  } catch (error) {
    throw new SkillError(
      "SKILL_ROOT_INVALID",
      `Agent Skills ${label} root is invalid: ${value}.`,
      { cause: error },
    );
  }
}

async function resolveScopeRoot(
  scope: SkillScope,
  trustRoot: string,
  configuredRoot: string,
): Promise<ScopeRoot | undefined> {
  let configuredStats;
  try {
    configuredStats = await lstat(configuredRoot);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    throw rootError(scope, configuredRoot, error);
  }

  try {
    const canonicalRoot = await realpath(configuredRoot);
    if (!isWithin(trustRoot, canonicalRoot)) {
      throw new SkillError(
        "SKILL_PATH_OUTSIDE_SCOPE",
        `Agent Skills ${scope} root resolves outside its trust boundary: ${configuredRoot}.`,
      );
    }
    const rootStats = await stat(canonicalRoot);
    if (!rootStats.isDirectory()) {
      throw new SkillError(
        "SKILL_ROOT_INVALID",
        `Agent Skills ${scope} root must be a directory: ${configuredRoot}.`,
      );
    }
    if (!configuredStats.isDirectory() && !configuredStats.isSymbolicLink()) {
      throw new SkillError(
        "SKILL_ROOT_INVALID",
        `Agent Skills ${scope} root must be a directory or directory symlink: ${configuredRoot}.`,
      );
    }
    return { scope, trustRoot, configuredRoot, canonicalRoot };
  } catch (error) {
    if (error instanceof SkillError) {
      throw error;
    }
    throw rootError(scope, configuredRoot, error);
  }
}

async function loadScopeCandidates(
  root: ScopeRoot,
  existingCount: number,
): Promise<LoadedSkill[]> {
  let entries;
  try {
    entries = await readdir(root.canonicalRoot, { withFileTypes: true });
  } catch (error) {
    throw rootError(root.scope, root.configuredRoot, error);
  }
  entries.sort((left, right) => compareText(left.name, right.name));

  const skills: LoadedSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    const logicalDirectory = path.join(root.canonicalRoot, entry.name);
    const canonicalSkillDirectory = await resolveSkillDirectory(
      root,
      logicalDirectory,
      entry.name,
    );
    const logicalSkillFile = path.join(logicalDirectory, "SKILL.md");
    let skillFileStats;
    try {
      skillFileStats = await lstat(logicalSkillFile);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        continue;
      }
      throw skillLoadError(root.scope, entry.name, error);
    }
    void skillFileStats;
    const discoveredCount = existingCount + skills.length + 1;
    if (discoveredCount > SKILL_COUNT_MAX) {
      throw new SkillError(
        "SKILL_COUNT_EXCEEDED",
        `Discovered ${discoveredCount} Agent Skills; the limit is ${SKILL_COUNT_MAX}.`,
      );
    }
    skills.push(
      await loadSkillFile({
        scope: root.scope,
        directoryName: entry.name,
        canonicalDirectory: canonicalSkillDirectory,
        logicalSkillFile,
      }),
    );
  }
  return skills;
}

async function resolveSkillDirectory(
  root: ScopeRoot,
  logicalDirectory: string,
  directoryName: string,
): Promise<string> {
  try {
    const canonical = await realpath(logicalDirectory);
    if (!isWithin(root.trustRoot, canonical)) {
      throw new SkillError(
        "SKILL_PATH_OUTSIDE_SCOPE",
        `Agent Skill ${root.scope}/${directoryName} resolves outside its trust boundary.`,
      );
    }
    const stats = await stat(canonical);
    if (!stats.isDirectory()) {
      throw new SkillError(
        "SKILL_ROOT_INVALID",
        `Agent Skill candidate ${root.scope}/${directoryName} is not a directory.`,
      );
    }
    return canonical;
  } catch (error) {
    if (error instanceof SkillError) {
      throw error;
    }
    throw skillLoadError(root.scope, directoryName, error);
  }
}

async function loadSkillFile(input: {
  scope: SkillScope;
  directoryName: string;
  canonicalDirectory: string;
  logicalSkillFile: string;
}): Promise<LoadedSkill> {
  let handle;
  try {
    handle = await open(
      input.logicalSkillFile,
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
  } catch (error) {
    throw skillLoadError(input.scope, input.directoryName, error);
  }

  try {
    const canonicalFile = await realpath(input.logicalSkillFile);
    if (!isWithin(input.canonicalDirectory, canonicalFile)) {
      throw new SkillError(
        "SKILL_PATH_OUTSIDE_SCOPE",
        `Agent Skill ${input.scope}/${input.directoryName}/SKILL.md resolves outside its skill directory.`,
      );
    }
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) {
      throw new SkillError(
        "SKILL_FILE_NOT_REGULAR",
        `Agent Skill ${input.scope}/${input.directoryName}/SKILL.md must be a regular file.`,
      );
    }
    const targetStats = await stat(canonicalFile);
    if (targetStats.dev !== openedStats.dev || targetStats.ino !== openedStats.ino) {
      throw new SkillError(
        "SKILL_FILE_NOT_REGULAR",
        `Agent Skill ${input.scope}/${input.directoryName}/SKILL.md changed while being opened.`,
      );
    }
    if (openedStats.size > SKILL_FILE_MAX_BYTES) {
      throw tooLargeError(input.scope, input.directoryName, openedStats.size);
    }
    const bytes = await readBounded(handle, SKILL_FILE_MAX_BYTES);
    if (bytes.byteLength > SKILL_FILE_MAX_BYTES) {
      throw tooLargeError(input.scope, input.directoryName, bytes.byteLength);
    }
    const canonicalFileAfterRead = await realpath(input.logicalSkillFile);
    const openedStatsAfterRead = await handle.stat();
    const targetStatsAfterRead = await stat(canonicalFileAfterRead);
    if (
      canonicalFileAfterRead !== canonicalFile ||
      openedStatsAfterRead.dev !== openedStats.dev ||
      openedStatsAfterRead.ino !== openedStats.ino ||
      openedStatsAfterRead.size !== openedStats.size ||
      openedStatsAfterRead.mtimeMs !== openedStats.mtimeMs ||
      openedStatsAfterRead.ctimeMs !== openedStats.ctimeMs ||
      targetStatsAfterRead.dev !== openedStatsAfterRead.dev ||
      targetStatsAfterRead.ino !== openedStatsAfterRead.ino
    ) {
      throw new SkillError(
        "SKILL_FILE_NOT_REGULAR",
        `Agent Skill ${input.scope}/${input.directoryName}/SKILL.md changed while being read.`,
      );
    }
    if (bytes.includes(0)) {
      throw new SkillError(
        "SKILL_FIELD_INVALID",
        `Agent Skill ${input.scope}/${input.directoryName}/SKILL.md contains a NUL byte.`,
      );
    }

    let content: string;
    try {
      content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
    } catch (error) {
      throw new SkillError(
        "SKILL_FILE_NOT_UTF8",
        `Agent Skill ${input.scope}/${input.directoryName}/SKILL.md is not valid UTF-8.`,
        { cause: error },
      );
    }
    const parsed = parseSkillDocument(content, input.scope, input.directoryName);
    return immutableRecord({
      name: parsed.name,
      description: parsed.description,
      scope: input.scope,
      directory: input.canonicalDirectory,
      skillFilePath: canonicalFile,
      content,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      frontmatter: parsed.frontmatter,
    });
  } catch (error) {
    if (error instanceof SkillError) {
      throw error;
    }
    throw skillLoadError(input.scope, input.directoryName, error);
  } finally {
    await handle.close().catch((error: unknown) => {
      throw skillLoadError(input.scope, input.directoryName, error);
    });
  }
}

function parseSkillDocument(
  content: string,
  scope: SkillScope,
  directoryName: string,
): Pick<LoadedSkill, "name" | "description" | "frontmatter"> {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") {
    throw frontmatterError(scope, directoryName, "must start with an exact --- line");
  }
  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex < 0) {
    throw frontmatterError(scope, directoryName, "has no closing --- line");
  }
  const frontmatterText = lines.slice(1, closingIndex).join("\n");
  const body = lines.slice(closingIndex + 1).join("\n");
  if (body.trim() === "") {
    throw new SkillError(
      "SKILL_BODY_EMPTY",
      `Agent Skill ${scope}/${directoryName}/SKILL.md must have a non-empty Markdown body.`,
    );
  }

  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(frontmatterText, {
      schema: "core",
      customTags: [],
      uniqueKeys: true,
      prettyErrors: false,
      strict: true,
    });
  } catch (error) {
    throw frontmatterError(scope, directoryName, errorMessage(error));
  }
  if (document.errors.length > 0 || document.warnings.length > 0) {
    const issue = document.errors[0] ?? document.warnings[0];
    throw frontmatterError(
      scope,
      directoryName,
      issue?.message ?? "could not be parsed",
    );
  }
  if (!isMap(document.contents)) {
    throw frontmatterError(scope, directoryName, "root must be a mapping");
  }
  let prohibitedNode = false;
  visit(document, {
    Node(_key, node) {
      const candidate = node;
      if (
        isAlias(node) ||
        candidate.anchor !== undefined ||
        (candidate.tag !== undefined && !candidate.tag.startsWith("tag:yaml.org,2002:"))
      ) {
        prohibitedNode = true;
        return visit.BREAK;
      }
      return undefined;
    },
  });
  if (prohibitedNode) {
    throw frontmatterError(
      scope,
      directoryName,
      "aliases, anchors, and custom tags are not supported",
    );
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw frontmatterError(scope, directoryName, errorMessage(error));
  }
  if (!isPlainRecord(value)) {
    throw frontmatterError(scope, directoryName, "root must be a plain mapping");
  }
  const name = requireStringField(value, "name", scope, directoryName);
  const description = requireStringField(value, "description", scope, directoryName);
  if (
    codePointLength(name) < 1 ||
    codePointLength(name) > 64 ||
    !SKILL_NAME_PATTERN.test(name)
  ) {
    throw fieldError(
      scope,
      directoryName,
      "name must be 1-64 lowercase ASCII letters, digits, or single hyphens",
    );
  }
  if (name !== directoryName) {
    throw new SkillError(
      "SKILL_NAME_MISMATCH",
      `Agent Skill ${scope}/${directoryName} declares name ${JSON.stringify(name)}; it must match the directory name.`,
    );
  }
  if (codePointLength(description) > 1_024) {
    throw fieldError(scope, directoryName, "description exceeds 1024 characters");
  }

  const license = optionalStringField(value, "license", scope, directoryName);
  const compatibility = optionalStringField(
    value,
    "compatibility",
    scope,
    directoryName,
  );
  if (
    compatibility !== undefined &&
    (codePointLength(compatibility) < 1 || codePointLength(compatibility) > 500)
  ) {
    throw fieldError(
      scope,
      directoryName,
      "compatibility must contain 1-500 characters",
    );
  }
  const allowedTools = optionalStringField(
    value,
    "allowed-tools",
    scope,
    directoryName,
  );
  const metadata = parseMetadata(
    value.metadata,
    document.get("metadata", true),
    scope,
    directoryName,
  );

  return {
    name,
    description,
    frontmatter: immutableRecord({
      ...(license === undefined ? {} : { license }),
      ...(compatibility === undefined ? {} : { compatibility }),
      ...(metadata === undefined ? {} : { metadata }),
      ...(allowedTools === undefined ? {} : { allowedTools }),
    }),
  };
}

function parseMetadata(
  value: unknown,
  node: unknown,
  scope: SkillScope,
  directoryName: string,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainRecord(value) || !isMap(node)) {
    throw fieldError(scope, directoryName, "metadata must be a plain mapping");
  }
  for (const pair of node.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
      throw fieldError(scope, directoryName, "metadata keys must be strings");
    }
  }
  const entries: Array<readonly [string, string]> = [];
  for (const key of Object.keys(value).sort(compareText)) {
    const child = value[key];
    if (typeof child !== "string") {
      throw fieldError(
        scope,
        directoryName,
        `metadata value for ${JSON.stringify(key)} must be a string`,
      );
    }
    entries.push([key, child]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function requireStringField(
  value: Record<string, unknown>,
  field: string,
  scope: SkillScope,
  directoryName: string,
): string {
  const result = optionalStringField(value, field, scope, directoryName);
  if (result === undefined) {
    throw fieldError(scope, directoryName, `${field} is required`);
  }
  if (result.trim() === "") {
    throw fieldError(scope, directoryName, `${field} must be a non-empty string`);
  }
  return result;
}

function optionalStringField(
  value: Record<string, unknown>,
  field: string,
  scope: SkillScope,
  directoryName: string,
): string | undefined {
  const result = value[field];
  if (result === undefined) {
    return undefined;
  }
  if (typeof result !== "string") {
    throw fieldError(scope, directoryName, `${field} must be a string`);
  }
  return result;
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return (
    Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null
  );
}

function codePointLength(value: string): number {
  return [...value].length;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function compareSkills(left: LoadedSkill, right: LoadedSkill): number {
  return compareText(left.name, right.name);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function scopeOrder(scope: SkillScope): number {
  return scope === "user" ? 0 : 1;
}

function tooLargeError(
  scope: SkillScope,
  directoryName: string,
  actual: number,
): SkillError {
  return new SkillError(
    "SKILL_FILE_TOO_LARGE",
    `Agent Skill ${scope}/${directoryName}/SKILL.md is ${actual} bytes; the limit is ${SKILL_FILE_MAX_BYTES} bytes.`,
  );
}

function frontmatterError(
  scope: SkillScope,
  directoryName: string,
  detail: string,
): SkillError {
  return new SkillError(
    "SKILL_FRONTMATTER_INVALID",
    `Agent Skill ${scope}/${directoryName}/SKILL.md frontmatter ${detail}.`,
  );
}

function fieldError(
  scope: SkillScope,
  directoryName: string,
  detail: string,
): SkillError {
  return new SkillError(
    "SKILL_FIELD_INVALID",
    `Agent Skill ${scope}/${directoryName}/SKILL.md ${detail}.`,
  );
}

function rootError(scope: SkillScope, root: string, cause: unknown): SkillError {
  return new SkillError(
    "SKILL_ROOT_INVALID",
    `Failed to load Agent Skills ${scope} root ${root}: ${errorMessage(cause)}.`,
    { cause },
  );
}

function skillLoadError(
  scope: SkillScope,
  directoryName: string,
  cause: unknown,
): SkillError {
  return new SkillError(
    "SKILL_FILE_NOT_REGULAR",
    `Failed to load Agent Skill ${scope}/${directoryName}: ${errorMessage(cause)}.`,
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
