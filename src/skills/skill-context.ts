import { createHash } from "node:crypto";
import path from "node:path";
import type { MessageId } from "../ids/runtime-id";
import { contentHash } from "../context/protocol-frame";
import { formatMessageSource } from "../context/context-source";
import type { SwapOverride } from "../context/context-revision";
import {
  ACTIVE_SKILL_COUNT_MAX,
  ACTIVE_SKILL_TOTAL_BYTES_MAX,
  SkillError,
  type LoadedSkill,
  type SkillCatalogSnapshot,
} from "./skill-loader";
import {
  activeSkillManifestEntry,
  type ActiveSkillManifestEntry,
} from "./skill-catalog";

export const SKILL_ACTIVATION_RECEIPT_FORMAT = "skill-activation-receipt-v1" as const;
export const SKILL_POLICY_VERSION = "agent-skills-v1" as const;

export type ActiveSkill = {
  readonly skill: LoadedSkill;
  readonly activationMessageId: MessageId;
};

export type SkillActivationLifecycle = "reserved" | "pending" | "dispatched";

export class SkillActivationCoordinator {
  private readonly active = new Map<string, ActiveSkill>();
  private readonly unresolved = new Map<
    string,
    { skill: LoadedSkill; lifecycle: SkillActivationLifecycle }
  >();

  constructor(input: { active?: readonly ActiveSkill[] } = {}) {
    for (const entry of input.active ?? []) {
      if (this.active.has(entry.skill.name)) {
        throw new SkillError(
          "SKILL_ACTIVATION_STATE_INVALID",
          `Duplicate active Agent Skill ${entry.skill.name}.`,
        );
      }
      this.active.set(entry.skill.name, entry);
    }
    this.assertLimits();
  }

  status(name: string):
    | { status: "inactive" }
    | { status: "active"; skill: LoadedSkill }
    | {
        status: "loaded";
        skill: LoadedSkill;
        lifecycle: "pending" | "dispatched";
      } {
    const active = this.active.get(name);
    if (active !== undefined) {
      return { status: "active", skill: active.skill };
    }
    const unresolved = this.unresolved.get(name);
    if (unresolved === undefined) {
      return { status: "inactive" };
    }
    return {
      status: "loaded",
      skill: unresolved.skill,
      lifecycle: unresolved.lifecycle === "dispatched" ? "dispatched" : "pending",
    };
  }

  reserve(skill: LoadedSkill): void {
    if (this.active.has(skill.name) || this.unresolved.has(skill.name)) {
      throw new SkillError(
        "SKILL_ACTIVATION_STATE_INVALID",
        `Agent Skill ${skill.name} is already active or loaded.`,
      );
    }
    this.unresolved.set(skill.name, { skill, lifecycle: "reserved" });
    try {
      this.assertLimits();
    } catch (error) {
      this.unresolved.delete(skill.name);
      throw error;
    }
  }

  release(name: string): void {
    const entry = this.unresolved.get(name);
    if (entry?.lifecycle === "reserved") {
      this.unresolved.delete(name);
    }
  }

  markPending(name: string): void {
    const entry = this.unresolved.get(name);
    if (entry?.lifecycle !== "reserved") {
      throw new SkillError(
        "SKILL_ACTIVATION_STATE_INVALID",
        `Agent Skill ${name} is not reserved for a pending activation.`,
      );
    }
    entry.lifecycle = "pending";
  }

  markDispatched(names: readonly string[]): void {
    if (new Set(names).size !== names.length) {
      throw new SkillError(
        "SKILL_ACTIVATION_STATE_INVALID",
        "Agent Skill dispatch list contains duplicate names.",
      );
    }
    for (const name of names) {
      const entry = this.unresolved.get(name);
      if (entry?.lifecycle !== "pending") {
        throw new SkillError(
          "SKILL_ACTIVATION_STATE_INVALID",
          `Agent Skill ${name} is not pending dispatch.`,
        );
      }
    }
    for (const name of names) {
      this.unresolved.get(name)!.lifecycle = "dispatched";
    }
  }

  replaceActive(entries: readonly ActiveSkill[]): void {
    validateActiveLimits(entries);
    const next = new Map<string, ActiveSkill>();
    for (const entry of entries) {
      if (next.has(entry.skill.name)) {
        throw new SkillError(
          "SKILL_ACTIVATION_STATE_INVALID",
          `Duplicate active Agent Skill ${entry.skill.name}.`,
        );
      }
      next.set(entry.skill.name, entry);
    }
    this.active.clear();
    for (const [name, entry] of next) {
      this.active.set(name, entry);
      this.unresolved.delete(entry.skill.name);
    }
  }

  settle(names: readonly string[]): void {
    for (const name of names) {
      this.unresolved.delete(name);
    }
  }

  activeEntries(): readonly ActiveSkill[] {
    return Object.freeze(
      [...this.active.values()].sort((left, right) =>
        compareText(left.skill.name, right.skill.name),
      ),
    );
  }

  activeManifest(): readonly ActiveSkillManifestEntry[] {
    return Object.freeze(
      this.activeEntries().map((entry) =>
        activeSkillManifestEntry(entry.skill, entry.activationMessageId),
      ),
    );
  }

  private assertLimits(): void {
    const skills = [
      ...[...this.active.values()].map((entry) => entry.skill),
      ...[...this.unresolved.values()].map((entry) => entry.skill),
    ];
    if (skills.length > ACTIVE_SKILL_COUNT_MAX) {
      throw new SkillError(
        "SKILL_ACTIVE_LIMIT_EXCEEDED",
        `Agent Skill activation count ${skills.length} exceeds the limit ${ACTIVE_SKILL_COUNT_MAX}.`,
      );
    }
    const bytes = skills.reduce((total, skill) => total + skill.byteLength, 0);
    if (bytes > ACTIVE_SKILL_TOTAL_BYTES_MAX) {
      throw new SkillError(
        "SKILL_ACTIVE_LIMIT_EXCEEDED",
        `Active Agent Skill content is ${bytes} bytes; the limit is ${ACTIVE_SKILL_TOTAL_BYTES_MAX} bytes.`,
      );
    }
  }
}

export function buildActiveSystemPrompt(input: {
  baseSystemPrompt: string;
  activeSkills: readonly ActiveSkill[];
}): string {
  if (input.baseSystemPrompt.trim() === "") {
    throw new SkillError(
      "SKILL_ACTIVATION_STATE_INVALID",
      "Base system prompt must not be empty.",
    );
  }
  if (input.activeSkills.length === 0) {
    return input.baseSystemPrompt;
  }
  const blocks = [...input.activeSkills]
    .sort((left, right) => compareText(left.skill.name, right.skill.name))
    .map(({ skill }) => renderActiveSkillBlock(skill));
  return `${input.baseSystemPrompt}\n\n<active_agent_skills>
The following Agent Skills are active for this session.
Use each skill only when relevant to the current task.
They do not override Tinker's runtime, tool protocol, project instructions,
or the user's explicit request.

${blocks.join("\n\n")}
</active_agent_skills>`;
}

export function rebindActiveSkills(input: {
  catalog: SkillCatalogSnapshot;
  active: readonly ActiveSkillManifestEntry[];
  promotionNames?: readonly { name: string; activationMessageId: MessageId }[];
}): {
  active: readonly ActiveSkill[];
  refreshed: readonly string[];
  deactivated: readonly string[];
} {
  const currentByName = new Map<string, ActiveSkillManifestEntry>();
  for (const entry of input.active) {
    if (currentByName.has(entry.name)) {
      throw new SkillError(
        "SKILL_ACTIVATION_STATE_INVALID",
        `Stored active Agent Skills contain duplicate name ${entry.name}.`,
      );
    }
    currentByName.set(entry.name, entry);
  }
  const active: ActiveSkill[] = [];
  const refreshed: string[] = [];
  const deactivated: string[] = [];
  for (const stored of [...currentByName.values()].sort((left, right) =>
    compareText(left.name, right.name),
  )) {
    const skill = input.catalog.skills.get(stored.name);
    if (skill === undefined) {
      deactivated.push(stored.name);
      continue;
    }
    active.push({ skill, activationMessageId: stored.activationMessageId });
    if (
      stored.scope !== skill.scope ||
      stored.directorySha256 !== hashDirectory(skill.directory) ||
      stored.descriptionSha256 !== contentDigest(skill.description) ||
      stored.skillFileSha256 !== skill.sha256 ||
      stored.byteLength !== skill.byteLength
    ) {
      refreshed.push(skill.name);
    }
  }
  const promotionNames = new Set<string>();
  for (const promotion of [...(input.promotionNames ?? [])].sort((left, right) =>
    compareText(left.name, right.name),
  )) {
    if (promotionNames.has(promotion.name) || currentByName.has(promotion.name)) {
      throw new SkillError(
        "SKILL_ACTIVATION_STATE_INVALID",
        `Agent Skill ${promotion.name} has duplicate active or dispatched state.`,
      );
    }
    promotionNames.add(promotion.name);
    const skill = input.catalog.skills.get(promotion.name);
    if (skill !== undefined) {
      active.push({ skill, activationMessageId: promotion.activationMessageId });
    }
  }
  active.sort((left, right) => compareText(left.skill.name, right.skill.name));
  validateActiveLimits(active);
  return {
    active: Object.freeze(active),
    refreshed: Object.freeze(refreshed),
    deactivated: Object.freeze(deactivated),
  };
}

export function renderSkillActivationReceipt(input: {
  message: {
    messageId: MessageId;
    frameId: SwapOverride["frameId"];
    ordinal: number;
    content: string;
    contentSha256: string;
  };
  name: string;
  outcome: "promoted" | "rejected" | "unavailable";
}): SwapOverride {
  const source = formatMessageSource(input.message.messageId);
  const renderedContent =
    input.outcome === "promoted"
      ? [
          "[Tinker Agent Skill activation promoted]",
          `name=${input.name}`,
          `source=${source}`,
          "activation=The full historical instructions were promoted out of this tool observation.",
          "current=Consult the current active_agent_skills system section; absence means inactive.",
          "historical=Use Recall get with source to recover the original activation observation.",
        ].join("\n")
      : [
          "[Tinker Agent Skill activation rejected]",
          `name=${input.name}`,
          `source=${source}`,
          `status=${input.outcome === "unavailable" ? "unavailable" : "not_dispatched"}`,
          "current=This skill was not added to the active system surface.",
          "historical=Use Recall get with source to recover the original activation observation.",
        ].join("\n");
  const originalBytes = Buffer.byteLength(input.message.content, "utf8");
  const renderedBytes = Buffer.byteLength(renderedContent, "utf8");
  return Object.freeze({
    frameId: input.message.frameId,
    messageId: input.message.messageId,
    ordinal: input.message.ordinal,
    source,
    originalContentSha256: input.message.contentSha256,
    renderedContent,
    renderedContentSha256: contentHash(renderedContent),
    originalBytes,
    renderedBytes,
    byteSavings: originalBytes - renderedBytes,
    rendererFormat: SKILL_ACTIVATION_RECEIPT_FORMAT,
  });
}

function renderActiveSkillBlock(skill: LoadedSkill): string {
  const content = skill.content + (skill.content.endsWith("\n") ? "" : "\n");
  return `<agent_skill name=${JSON.stringify(skill.name)} scope=${JSON.stringify(skill.scope)}>
Skill directory: ${skill.directory}
Relative paths resolve from this directory.
<skill_file>
${content}</skill_file>
</agent_skill>`;
}

function validateActiveLimits(active: readonly ActiveSkill[]): void {
  if (active.length > ACTIVE_SKILL_COUNT_MAX) {
    throw new SkillError(
      "SKILL_ACTIVE_LIMIT_EXCEEDED",
      `Active Agent Skill count ${active.length} exceeds the limit ${ACTIVE_SKILL_COUNT_MAX}.`,
    );
  }
  const bytes = active.reduce((total, entry) => total + entry.skill.byteLength, 0);
  if (bytes > ACTIVE_SKILL_TOTAL_BYTES_MAX) {
    throw new SkillError(
      "SKILL_ACTIVE_LIMIT_EXCEEDED",
      `Active Agent Skill content is ${bytes} bytes; the limit is ${ACTIVE_SKILL_TOTAL_BYTES_MAX} bytes.`,
    );
  }
}

function hashDirectory(directory: string): string {
  return contentDigest(path.resolve(directory));
}

function contentDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
