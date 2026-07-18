import type { MessageId } from "../ids/runtime-id";
import { sha256, stableJsonStringify } from "../model/model-request-preflight";
import type { ToolDefinition } from "../tools/types";
import { immutableCanonicalClone, immutableRecord } from "../context/protocol-frame";
import {
  SKILL_CATALOG_MAX_BYTES,
  SkillError,
  type LoadedSkill,
  type SkillCatalogSnapshot,
  type SkillScope,
  type SkillShadow,
} from "./skill-loader";

export type SkillCatalogManifestEntry = {
  readonly name: string;
  readonly scope: SkillScope;
  readonly directorySha256: string;
  readonly descriptionSha256: string;
  readonly skillFileSha256: string;
  readonly byteLength: number;
};

export type ActiveSkillManifestEntry = SkillCatalogManifestEntry & {
  readonly activationMessageId: MessageId;
};

export function createSkillCatalogSnapshot(input: {
  workspaceRoot: string;
  homeRoot: string;
  skills: readonly LoadedSkill[];
  shadowed: readonly SkillShadow[];
}): SkillCatalogSnapshot {
  const sorted = [...input.skills].sort((left, right) =>
    compareText(left.name, right.name),
  );
  if (new Set(sorted.map((skill) => skill.name)).size !== sorted.length) {
    throw new SkillError(
      "SKILL_ACTIVATION_STATE_INVALID",
      "Agent Skill catalog contains duplicate winning names.",
    );
  }
  const skills = new ImmutableMap(sorted.map((skill) => [skill.name, skill] as const));
  const manifest = skillCatalogManifest(sorted);
  const snapshot: SkillCatalogSnapshot = Object.freeze({
    workspaceRoot: input.workspaceRoot,
    homeRoot: input.homeRoot,
    skills,
    shadowed: Object.freeze([...input.shadowed]),
    manifestSha256: sha256(stableJsonStringify(manifest)),
  });
  if (skills.size > 0) {
    const definition = createSkillToolDefinition(snapshot);
    const bytes = Buffer.byteLength(stableJsonStringify(definition), "utf8");
    if (bytes > SKILL_CATALOG_MAX_BYTES) {
      throw new SkillError(
        "SKILL_CATALOG_TOO_LARGE",
        `Agent Skill catalog is ${bytes} bytes; the limit is ${SKILL_CATALOG_MAX_BYTES} bytes.`,
      );
    }
  }
  return snapshot;
}

export function skillCatalogManifest(
  skills: Iterable<LoadedSkill>,
): readonly SkillCatalogManifestEntry[] {
  return Object.freeze(
    [...skills]
      .sort((left, right) => compareText(left.name, right.name))
      .map((skill) => skillManifestEntry(skill)),
  );
}

export function skillManifestEntry(skill: LoadedSkill): SkillCatalogManifestEntry {
  return immutableRecord({
    name: skill.name,
    scope: skill.scope,
    directorySha256: sha256(skill.directory),
    descriptionSha256: sha256(skill.description),
    skillFileSha256: skill.sha256,
    byteLength: skill.byteLength,
  });
}

export function activeSkillManifestEntry(
  skill: LoadedSkill,
  activationMessageId: MessageId,
): ActiveSkillManifestEntry {
  return immutableRecord({
    ...skillManifestEntry(skill),
    activationMessageId,
  });
}

export function skillManifestSha256(
  manifest: readonly SkillCatalogManifestEntry[],
): string {
  return sha256(stableJsonStringify(manifest));
}

export function activeSkillManifestSha256(
  manifest: readonly ActiveSkillManifestEntry[],
): string {
  return sha256(stableJsonStringify(manifest));
}

export function createSkillToolDefinition(
  catalog: SkillCatalogSnapshot,
): ToolDefinition {
  const skills = [...catalog.skills.values()].sort((left, right) =>
    compareText(left.name, right.name),
  );
  if (skills.length === 0) {
    throw new SkillError(
      "SKILL_ACTIVATION_STATE_INVALID",
      "Cannot create the Skill tool for an empty catalog.",
    );
  }
  const lines = skills.map((skill) =>
    stableJsonStringify({
      description: skill.description,
      name: skill.name,
    }),
  );
  return immutableCanonicalClone({
    name: "Skill",
    description: [
      "Load specialized Agent Skills instructions before proceeding when a task matches.",
      "Available skills (one JSON object per line):",
      ...lines,
    ].join("\n"),
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: {
          type: "string",
          enum: skills.map((skill) => skill.name),
        },
      },
      required: ["name"],
    },
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

class ImmutableMap<K, V> extends Map<K, V> {
  private locked = false;

  constructor(entries: readonly (readonly [K, V])[]) {
    super();
    for (const [key, value] of entries) {
      Map.prototype.set.call(this, key, value);
    }
    this.locked = true;
    Object.freeze(this);
  }

  override set(key: K, value: V): this {
    if (this.locked) {
      throw new TypeError("Agent Skill catalog is immutable.");
    }
    return super.set(key, value);
  }

  override delete(key: K): boolean {
    if (this.locked) {
      throw new TypeError("Agent Skill catalog is immutable.");
    }
    return super.delete(key);
  }

  override clear(): void {
    if (this.locked) {
      throw new TypeError("Agent Skill catalog is immutable.");
    }
    super.clear();
  }
}
