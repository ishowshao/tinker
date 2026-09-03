import path from "node:path";
import { parseMessageId, type MessageId } from "../ids/runtime-id";
import { sha256 } from "../model/model-request-preflight";
import type { ToolRawResult } from "../tools/types";
import { immutableCanonicalClone, immutableRecord } from "../context/protocol-frame";
import {
  parseImageAssetId,
  validateImageAssetRef,
  validateOriginalImageName,
  type ImageAssetRef,
} from "../image/image-types";
import {
  SKILL_FILE_MAX_BYTES,
  SKILL_RESOURCE_MAX_DEPTH,
  SKILL_RESOURCE_MAX_ENTRIES,
} from "../skills/skill-loader";
import {
  assertObjectKeys,
  enumFromSql,
  nonEmptyStringFromJson,
  nonNegativeJsonInteger,
  numberFromJson,
  positiveJsonInteger,
  recordFromSql,
  sha256FromSql,
  stringFromSql,
} from "./session-store-value-codecs";

export function decodeStoredToolRawResult(value: unknown): ToolRawResult {
  const raw = recordFromSql(value, "tool raw result");
  const kind = enumFromSql(
    raw.kind,
    [
      "read",
      "view_image",
      "write",
      "edit",
      "delete",
      "glob",
      "grep",
      "bash",
      "update_plan",
      "task_list",
      "task_output",
      "task_input",
      "task_stop",
      "web_search",
      "web_fetch",
      "recall",
      "context_maintenance",
      "memory_search",
      "memory_get",
      "memory_create",
      "memory_update",
      "memory_delete",
      "wait",
      "skill",
      "mcp",
      "generic",
    ] as const,
    "tool raw result kind",
  );
  if (typeof raw.ok !== "boolean") {
    throw new Error("tool raw result ok must be a boolean.");
  }
  if (kind === "skill") {
    return decodeStoredSkillRawResult(raw);
  }
  if (kind === "view_image") {
    return decodeStoredViewImageRawResult(raw);
  }
  if (kind === "context_maintenance") {
    return decodeStoredContextMaintenanceRawResult(raw);
  }
  return immutableCanonicalClone(raw) as ToolRawResult;
}

function decodeStoredContextMaintenanceRawResult(
  raw: Record<string, unknown>,
): Extract<ToolRawResult, { kind: "context_maintenance" }> {
  const operation = enumFromSql(
    raw.operation,
    ["status", "candidates", "swap"] as const,
    "context maintenance operation",
  );
  if (raw.ok === false) {
    if (operation !== "swap") {
      assertObjectKeys(
        raw,
        ["kind", "ok", "operation", "error"],
        ["kind", "ok", "operation", "error"],
        `failed context ${operation} result`,
      );
      return immutableRecord({
        kind: "context_maintenance" as const,
        ok: false as const,
        operation,
        error: nonEmptyStringFromJson(raw.error, `context ${operation} error`),
      });
    }
    assertObjectKeys(
      raw,
      ["kind", "ok", "operation", "scheduled", "rejected", "error"],
      ["kind", "ok", "operation", "scheduled", "rejected"],
      "failed context swap result",
    );
    if (!Array.isArray(raw.scheduled) || raw.scheduled.length !== 0) {
      throw new Error("Failed context swap result must schedule no candidates.");
    }
    const rejected = decodeContextSwapRejected(raw.rejected);
    const error =
      raw.error === undefined
        ? undefined
        : nonEmptyStringFromJson(raw.error, "context swap error");
    if (rejected.length === 0 && error === undefined) {
      throw new Error("Failed context swap result must explain its failure.");
    }
    return immutableRecord({
      kind: "context_maintenance" as const,
      ok: false as const,
      operation,
      scheduled: Object.freeze([]),
      rejected,
      ...(error === undefined ? {} : { error }),
    });
  }
  if (raw.ok !== true) {
    throw new Error("Context maintenance raw result ok must be a boolean.");
  }
  if (operation === "status") {
    assertObjectKeys(
      raw,
      [
        "kind",
        "ok",
        "operation",
        "usedInputTokens",
        "inputBudgetTokens",
        "pressure",
        "triggerTokens",
        "source",
      ],
      [
        "kind",
        "ok",
        "operation",
        "usedInputTokens",
        "inputBudgetTokens",
        "pressure",
        "triggerTokens",
        "source",
      ],
      "context status result",
    );
    return immutableRecord({
      kind: "context_maintenance" as const,
      ok: true as const,
      operation,
      usedInputTokens: nonNegativeJsonInteger(
        raw.usedInputTokens,
        "context status usedInputTokens",
      ),
      inputBudgetTokens: positiveJsonInteger(
        raw.inputBudgetTokens,
        "context status inputBudgetTokens",
      ),
      pressure: enumFromSql(
        raw.pressure,
        ["normal", "high", "critical"] as const,
        "context status pressure",
      ),
      triggerTokens: positiveJsonInteger(
        raw.triggerTokens,
        "context status triggerTokens",
      ),
      source: enumFromSql(
        raw.source,
        [
          "estimated_full",
          "provider_measured",
          "measured_plus_estimated_delta",
        ] as const,
        "context status source",
      ),
    });
  }
  if (operation === "candidates") {
    assertObjectKeys(
      raw,
      ["kind", "ok", "operation", "total", "candidates"],
      ["kind", "ok", "operation", "total", "candidates"],
      "context swap candidates result",
    );
    if (!Array.isArray(raw.candidates) || raw.candidates.length > 50) {
      throw new Error("Context swap candidates result has an invalid page.");
    }
    const candidates = raw.candidates.map((value, index) => {
      const candidate = recordFromSql(value, `context candidate ${index}`);
      assertObjectKeys(
        candidate,
        ["candidateId", "label", "ordinal", "savingsBytes"],
        ["candidateId", "label", "ordinal", "savingsBytes"],
        `context candidate ${index}`,
      );
      const label = stringFromSql(candidate.label, `context candidate ${index} label`);
      if (
        label === "" ||
        label !== label.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim() ||
        Buffer.byteLength(label, "utf8") > 80
      ) {
        throw new Error(`Context candidate ${index} label is invalid or too large.`);
      }
      return immutableRecord({
        candidateId: parseMessageId(
          stringFromSql(candidate.candidateId, `context candidate ${index} ID`),
        ),
        label,
        ordinal: positiveJsonInteger(
          candidate.ordinal,
          `context candidate ${index} ordinal`,
        ),
        savingsBytes: positiveJsonInteger(
          candidate.savingsBytes,
          `context candidate ${index} savingsBytes`,
        ),
      });
    });
    if (
      new Set(candidates.map((candidate) => candidate.candidateId)).size !==
        candidates.length ||
      candidates.some(
        (candidate, index) =>
          index > 0 &&
          candidate.ordinal <= (candidates[index - 1]?.ordinal ?? candidate.ordinal),
      )
    ) {
      throw new Error(
        "Context swap candidates must have unique IDs and ascending ordinals.",
      );
    }
    const total = nonNegativeJsonInteger(raw.total, "context candidates total");
    if (total < candidates.length) {
      throw new Error("Context candidates total is smaller than its page.");
    }
    return immutableRecord({
      kind: "context_maintenance" as const,
      ok: true as const,
      operation,
      total,
      candidates: Object.freeze(candidates),
    });
  }

  assertObjectKeys(
    raw,
    ["kind", "ok", "operation", "scheduled", "rejected", "note"],
    ["kind", "ok", "operation", "scheduled", "rejected", "note"],
    "context swap result",
  );
  if (!Array.isArray(raw.scheduled) || raw.scheduled.length < 1) {
    throw new Error("Successful context swap result must schedule candidates.");
  }
  const scheduled = raw.scheduled.map((value, index) => {
    const candidate = recordFromSql(value, `scheduled context candidate ${index}`);
    assertObjectKeys(
      candidate,
      ["candidateId", "savingsBytes"],
      ["candidateId", "savingsBytes"],
      `scheduled context candidate ${index}`,
    );
    return immutableRecord({
      candidateId: parseMessageId(
        stringFromSql(candidate.candidateId, `scheduled candidate ${index} ID`),
      ),
      savingsBytes: positiveJsonInteger(
        candidate.savingsBytes,
        `scheduled candidate ${index} savingsBytes`,
      ),
    });
  });
  if (
    scheduled.length > 16 ||
    new Set(scheduled.map((candidate) => candidate.candidateId)).size !==
      scheduled.length
  ) {
    throw new Error("Successful context swap result has invalid scheduled IDs.");
  }
  const rejected = decodeContextSwapRejected(raw.rejected);
  if (
    scheduled.length + rejected.length > 16 ||
    scheduled.some((scheduledCandidate) =>
      rejected.some(
        (rejectedCandidate) =>
          rejectedCandidate.candidateId === scheduledCandidate.candidateId,
      ),
    )
  ) {
    throw new Error("Context swap result candidate partitions are invalid.");
  }
  const note = stringFromSql(raw.note, "context swap note");
  return immutableRecord({
    kind: "context_maintenance" as const,
    ok: true as const,
    operation,
    scheduled: Object.freeze(scheduled),
    rejected,
    note,
  });
}

function decodeContextSwapRejected(value: unknown): readonly {
  readonly candidateId: MessageId;
  readonly reason: string;
}[] {
  if (!Array.isArray(value) || value.length > 16) {
    throw new Error("Context swap rejected candidates must be an array of at most 16.");
  }
  const rejected = value.map((entry, index) => {
    const candidate = recordFromSql(entry, `rejected context candidate ${index}`);
    assertObjectKeys(
      candidate,
      ["candidateId", "reason"],
      ["candidateId", "reason"],
      `rejected context candidate ${index}`,
    );
    const reason = stringFromSql(
      candidate.reason,
      `rejected context candidate ${index} reason`,
    );
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(reason)) {
      throw new Error(`Rejected context candidate ${index} reason is invalid.`);
    }
    return immutableRecord({
      candidateId: parseMessageId(
        stringFromSql(candidate.candidateId, `rejected candidate ${index} ID`),
      ),
      reason,
    });
  });
  if (
    new Set(rejected.map((candidate) => candidate.candidateId)).size !== rejected.length
  ) {
    throw new Error("Context swap rejected candidate IDs must be unique.");
  }
  return Object.freeze(rejected);
}

function decodeStoredViewImageRawResult(
  raw: Record<string, unknown>,
): Extract<ToolRawResult, { kind: "view_image" }> {
  assertObjectKeys(
    raw,
    ["kind", "ok", "filePath", "originalName", "asset", "error"],
    ["kind", "ok", "filePath"],
    "ViewImage raw result",
  );
  const filePath = stringFromSql(raw.filePath, "ViewImage filePath");
  if (raw.ok === false) {
    if (raw.originalName !== undefined || raw.asset !== undefined) {
      throw new Error("Failed ViewImage raw result cannot contain image metadata.");
    }
    const error = stringFromSql(raw.error, "ViewImage error");
    if (error.trim() === "") {
      throw new Error("Failed ViewImage raw result error must not be empty.");
    }
    return immutableRecord({ kind: "view_image", ok: false, filePath, error });
  }
  if (raw.ok !== true || raw.error !== undefined || filePath.trim() === "") {
    throw new Error("Successful ViewImage raw result is invalid.");
  }
  const originalName = stringFromSql(raw.originalName, "ViewImage originalName");
  validateOriginalImageName(originalName);
  const storedAsset = recordFromSql(raw.asset, "ViewImage asset");
  assertObjectKeys(
    storedAsset,
    ["assetId", "mimeType", "byteLength", "width", "height"],
    ["assetId", "mimeType", "byteLength", "width", "height"],
    "ViewImage asset",
  );
  const asset: ImageAssetRef = immutableRecord({
    assetId: parseImageAssetId(stringFromSql(storedAsset.assetId, "assetId")),
    mimeType: enumFromSql(
      storedAsset.mimeType,
      ["image/png", "image/jpeg", "image/webp"] as const,
      "ViewImage asset mimeType",
    ),
    byteLength: numberFromJson(storedAsset.byteLength, "ViewImage asset byteLength"),
    width: numberFromJson(storedAsset.width, "ViewImage asset width"),
    height: numberFromJson(storedAsset.height, "ViewImage asset height"),
  });
  validateImageAssetRef(asset);
  return immutableRecord({
    kind: "view_image",
    ok: true,
    filePath,
    originalName,
    asset,
  });
}

function decodeStoredSkillRawResult(
  raw: Record<string, unknown>,
): Extract<ToolRawResult, { kind: "skill" }> {
  const status = enumFromSql(
    raw.status,
    ["loaded", "already_loaded", "already_active", "failed"] as const,
    "Skill raw result status",
  );
  const name = stringFromSql(raw.name, "Skill raw result name");
  if (status === "failed") {
    if (raw.ok !== false) {
      throw new Error("Failed Skill raw result must have ok=false.");
    }
    assertObjectKeys(
      raw,
      ["kind", "ok", "status", "name", "errorCode", "error"],
      ["kind", "ok", "status", "name", "errorCode", "error"],
      "failed Skill raw result",
    );
    const errorCode = stringFromSql(raw.errorCode, "Skill errorCode");
    const error = stringFromSql(raw.error, "Skill error");
    if (
      (name !== "" && !isValidSkillName(name)) ||
      !/^[A-Z][A-Z0-9_]{0,79}$/.test(errorCode) ||
      error.trim() === ""
    ) {
      throw new Error("Failed Skill raw result fields are invalid.");
    }
    return immutableRecord({
      kind: "skill" as const,
      ok: false as const,
      status,
      name,
      errorCode,
      error,
    });
  }
  if (raw.ok !== true) {
    throw new Error("Successful Skill raw result must have ok=true.");
  }
  const scope = enumFromSql(
    raw.scope,
    ["project", "user"] as const,
    "Skill raw result scope",
  );
  const skillFileSha256 = sha256FromSql(raw.sha256, "Skill raw result sha256");
  if (!isValidSkillName(name)) {
    throw new Error("Successful Skill raw result name is invalid.");
  }
  if (status === "already_loaded") {
    assertObjectKeys(
      raw,
      ["kind", "ok", "status", "name", "scope", "lifecycle", "sha256"],
      ["kind", "ok", "status", "name", "scope", "lifecycle", "sha256"],
      "already loaded Skill raw result",
    );
    return immutableRecord({
      kind: "skill" as const,
      ok: true as const,
      status,
      name,
      scope,
      lifecycle: enumFromSql(
        raw.lifecycle,
        ["pending", "dispatched"] as const,
        "Skill lifecycle",
      ),
      sha256: skillFileSha256,
    });
  }
  if (status === "already_active") {
    assertObjectKeys(
      raw,
      ["kind", "ok", "status", "name", "scope", "sha256"],
      ["kind", "ok", "status", "name", "scope", "sha256"],
      "already active Skill raw result",
    );
    return immutableRecord({
      kind: "skill" as const,
      ok: true as const,
      status,
      name,
      scope,
      sha256: skillFileSha256,
    });
  }
  assertObjectKeys(
    raw,
    [
      "kind",
      "ok",
      "status",
      "name",
      "scope",
      "directory",
      "skillFilePath",
      "content",
      "byteLength",
      "sha256",
      "resources",
      "resourcesTruncated",
    ],
    [
      "kind",
      "ok",
      "status",
      "name",
      "scope",
      "directory",
      "skillFilePath",
      "content",
      "byteLength",
      "sha256",
      "resources",
      "resourcesTruncated",
    ],
    "loaded Skill raw result",
  );
  if (
    !Array.isArray(raw.resources) ||
    raw.resources.some((entry) => typeof entry !== "string") ||
    raw.resources.length > SKILL_RESOURCE_MAX_ENTRIES ||
    typeof raw.resourcesTruncated !== "boolean"
  ) {
    throw new Error("Loaded Skill resource manifest is invalid.");
  }
  const directory = stringFromSql(raw.directory, "Skill directory");
  const skillFilePath = stringFromSql(raw.skillFilePath, "Skill file path");
  const content = stringFromSql(raw.content, "Skill content");
  const byteLength = numberFromJson(raw.byteLength, "Skill byteLength");
  const resources = raw.resources as string[];
  if (
    !path.isAbsolute(directory) ||
    !path.isAbsolute(skillFilePath) ||
    !isPathWithin(directory, skillFilePath) ||
    byteLength < 1 ||
    byteLength > SKILL_FILE_MAX_BYTES ||
    Buffer.byteLength(content, "utf8") !== byteLength ||
    sha256(content) !== skillFileSha256 ||
    !isValidResourceManifest(resources)
  ) {
    throw new Error("Loaded Skill raw result snapshot is invalid.");
  }
  return immutableRecord({
    kind: "skill" as const,
    ok: true as const,
    status,
    name,
    scope,
    directory,
    skillFilePath,
    content,
    byteLength,
    sha256: skillFileSha256,
    resources: Object.freeze([...resources]),
    resourcesTruncated: raw.resourcesTruncated,
  });
}

function isValidSkillName(value: string): boolean {
  return value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isValidResourceManifest(resources: readonly string[]): boolean {
  let previous: string | undefined;
  for (const resource of resources) {
    const parts = resource.split("/");
    if (
      resource === "" ||
      resource.includes("\\") ||
      path.posix.isAbsolute(resource) ||
      path.posix.normalize(resource) !== resource ||
      !["assets", "references", "scripts"].includes(parts[0] ?? "") ||
      parts.length < 2 ||
      parts.length > SKILL_RESOURCE_MAX_DEPTH + 1 ||
      (previous !== undefined && previous >= resource)
    ) {
      return false;
    }
    previous = resource;
  }
  return true;
}
