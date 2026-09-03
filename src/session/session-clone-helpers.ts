import path from "node:path";
import { chmod, lstat, open, readFile } from "node:fs/promises";
import { Database } from "bun:sqlite";
import type { SessionId } from "../ids/runtime-id";
import { stableJsonStringify } from "../model/model-request-preflight";
import type { ProtocolContextView } from "../context/protocol-frame";
import {
  canonicalSequenceHash,
  renderedMessageHash,
} from "../context/compiled-context-hash";
import { ContextRevisionCompiler } from "../context/context-revision-compiler";
import type { AgentEvent } from "../events/types";
import { renderObservationLogEvent } from "../events/observation-text-log";
import type { CloneSessionFaultStage } from "./session-store-contracts";
import { validateSecureFile } from "./session-store-filesystem";
import {
  decodeContextRevision,
  decodeContextSurface,
  decodeStoredSwapOverride,
  decodeStoredToolCalls,
  protocolPrefixView,
} from "./session-store-record-codecs";

export const SESSION_SCOPED_TABLES = [
  "session_meta",
  "turns",
  "iterations",
  "protocol_frames",
  "messages",
  "tool_results",
  "context_surfaces",
  "context_revisions",
  "context_overrides",
  "skill_activations",
  "context_measurement_state",
] as const;

export function rekeyStoredToolCalls(
  database: Database,
  targetSessionId: SessionId,
): void {
  const rows = database
    .query(
      `SELECT message_id, tool_calls_json FROM messages
       WHERE tool_calls_json IS NOT NULL ORDER BY ordinal`,
    )
    .all() as Array<{ message_id: string; tool_calls_json: string }>;
  for (const row of rows) {
    const calls = decodeStoredToolCalls(row.tool_calls_json).map((call) => ({
      ...call,
      sessionId: targetSessionId,
    }));
    database
      .query("UPDATE messages SET tool_calls_json = ? WHERE message_id = ?")
      .run(stableJsonStringify(calls), row.message_id);
  }
}

export function rekeyProtocolView(
  source: ProtocolContextView,
  targetSessionId: SessionId,
): ProtocolContextView {
  return {
    sessionId: targetSessionId,
    faulted: source.faulted,
    frames: source.frames.map((frame) => ({
      ...frame,
      sessionId: targetSessionId,
    })),
    messages: source.messages.map((message) => ({
      ...message,
      sessionId: targetSessionId,
      ...(message.role === "assistant" && message.toolCalls !== undefined
        ? {
            toolCalls: message.toolCalls.map((call) => ({
              ...call,
              sessionId: targetSessionId,
            })),
          }
        : {}),
    })),
    toolResults: source.toolResults.map((result) => ({
      ...result,
      sessionId: targetSessionId,
    })),
  };
}

export function rewriteCloneRevisionHashes(
  database: Database,
  canonical: ProtocolContextView,
): void {
  const surfaces = database
    .query("SELECT * FROM context_surfaces")
    .all()
    .map(decodeContextSurface);
  const surfacesById = new Map(surfaces.map((surface) => [surface.surfaceId, surface]));
  const revisions = database
    .query("SELECT * FROM context_revisions ORDER BY revision_number")
    .all()
    .map(decodeContextRevision);
  const revisionNumberById = new Map(
    revisions.map((revision) => [revision.revisionId, revision.revisionNumber]),
  );
  const overrides = database
    .query(
      `SELECT co.* FROM context_overrides co
       JOIN context_revisions cr ON cr.revision_id = co.introduced_revision_id
       ORDER BY cr.revision_number, co.ordinal`,
    )
    .all()
    .map(decodeStoredSwapOverride);
  const compiler = new ContextRevisionCompiler();
  for (const revision of revisions) {
    const surface = surfacesById.get(revision.surfaceId);
    if (surface === undefined) {
      throw new Error(`Cloned revision ${revision.revisionId} has no surface.`);
    }
    const activeOverrides = overrides.filter(
      (override) =>
        (revisionNumberById.get(override.introducedRevisionId) ??
          Number.POSITIVE_INFINITY) <= revision.revisionNumber &&
        override.ordinal >= revision.keepFromOrdinal,
    );
    const prefix = protocolPrefixView(canonical, revision.sourceThroughOrdinal);
    const compiled = compiler.compileForIdentityRekey({
      canonical: prefix,
      revisionId: revision.revisionId,
      activeOverrides,
      keepFromOrdinal: revision.keepFromOrdinal,
      surface,
    });
    database
      .query(
        `UPDATE context_revisions
         SET canonical_sequence_sha256 = ?, rendered_message_sha256 = ?
         WHERE revision_id = ?`,
      )
      .run(
        canonicalSequenceHash(canonical, revision.sourceThroughOrdinal),
        renderedMessageHash(compiled.entries, revision.sourceThroughOrdinal),
        revision.revisionId,
      );
  }
}

export async function cloneDiagnosticFiles(input: {
  sourceDirectory: string;
  stagingDirectory: string;
  sourceSessionId: SessionId;
  targetSessionId: SessionId;
  nextEventSequence: number;
  faultInjector?: (stage: CloneSessionFaultStage) => void;
}): Promise<void> {
  const sourcePath = path.join(input.sourceDirectory, "events.jsonl");
  try {
    await lstat(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  await validateSecureFile(sourcePath, input.sourceSessionId);

  const bytes = await readFile(sourcePath);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const rawLines = text.split("\n");
  if (rawLines.at(-1) === "") {
    rawLines.pop();
  }
  const events: AgentEvent[] = [];
  let previousSequence = 0;
  for (const [index, line] of rawLines.entries()) {
    if (line === "") {
      throw new Error(`Session event log contains an empty line at ${index + 1}.`);
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`Session event log has invalid JSON at line ${index + 1}.`, {
        cause: error,
      });
    }
    if (!isEventEnvelope(value)) {
      throw new Error(
        `Session event log has an invalid envelope at line ${index + 1}.`,
      );
    }
    if (value.sessionId !== input.sourceSessionId) {
      throw new Error(`Session event log identity changed at line ${index + 1}.`);
    }
    if (value.eventSequence <= previousSequence) {
      throw new Error(
        `Session event sequence is not strictly increasing at line ${index + 1}.`,
      );
    }
    if (value.eventSequence >= input.nextEventSequence) {
      throw new Error(
        `Session event sequence exceeds the canonical next counter at line ${index + 1}.`,
      );
    }
    previousSequence = value.eventSequence;
    events.push({ ...value, sessionId: input.targetSessionId });
  }

  const eventText = events.map((event) => JSON.stringify(event)).join("\n");
  await writePrivateNewFile(
    path.join(input.stagingDirectory, "events.jsonl"),
    eventText === "" ? "" : `${eventText}\n`,
  );
  input.faultInjector?.("after_event_rewrite");
  const observationText = events
    .map((event) => renderObservationLogEvent(event))
    .filter((block): block is string => block !== undefined)
    .join("");
  await writePrivateNewFile(
    path.join(input.stagingDirectory, "observations.md"),
    observationText,
  );
  input.faultInjector?.("after_observation_render");
}

function isEventEnvelope(value: unknown): value is AgentEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.sessionId === "string" &&
    Number.isSafeInteger(record.eventSequence) &&
    Number(record.eventSequence) >= 1 &&
    typeof record.timestamp === "string" &&
    typeof record.type === "string" &&
    record.data !== null &&
    typeof record.data === "object"
  );
}

async function writePrivateNewFile(filePath: string, content: string): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  await chmod(filePath, 0o600);
}
