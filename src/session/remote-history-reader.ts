import { Database } from "bun:sqlite";
import type { SessionId } from "../ids/runtime-id";
import { verifyReadableSessionSchema } from "./session-schema";
import { decodeStoredToolCalls } from "./session-store-record-codecs";

export type RemoteMessage = {
  id: string;
  ordinal: number;
  role: "user" | "assistant" | "tool";
  text: string;
  turnId: string;
  turnStatus: string;
  createdAt: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
};

export type RemoteHistoryPage = {
  messages: RemoteMessage[];
  hasMore: boolean;
  beforeOrdinal?: number;
};

/** A read-only canonical projection; open tails are legal and never synthesized. */
export class RemoteHistoryReader {
  private readonly database: Database;
  constructor(databasePath: string, sessionId: SessionId, workspaceRoot: string) {
    this.database = new Database(databasePath, { readonly: true, strict: true });
    try {
      verifyReadableSessionSchema(this.database, sessionId);
      const identity = this.database
        .query("SELECT session_id, workspace_root FROM session_meta")
        .get() as { session_id: string; workspace_root: string } | null;
      if (
        identity?.session_id !== sessionId ||
        identity.workspace_root !== workspaceRoot
      ) {
        throw new Error(
          "Remote history identity does not match its workspace/session.",
        );
      }
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  page(before = Number.MAX_SAFE_INTEGER, limit = 80): RemoteHistoryPage {
    const rows = this.database
      .query(
        `${MESSAGE_SELECT} WHERE m.role <> 'system' AND m.ordinal < ? ORDER BY m.ordinal DESC LIMIT ?`,
      )
      .all(before, limit + 1) as MessageRow[];
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).reverse().map(projectMessage);
    return {
      messages,
      hasMore,
      ...(messages[0] ? { beforeOrdinal: messages[0].ordinal } : {}),
    };
  }

  after(ordinal: number): RemoteMessage[] {
    return (
      this.database
        .query(
          `${MESSAGE_SELECT} WHERE m.role <> 'system' AND m.ordinal > ? ORDER BY m.ordinal`,
        )
        .all(ordinal) as MessageRow[]
    ).map(projectMessage);
  }

  latestTurn(): { id: string; status: string; error?: string } | undefined {
    const row = this.database
      .query(
        "SELECT turn_id, status, terminal_detail_json FROM turns ORDER BY turn_number DESC LIMIT 1",
      )
      .get() as {
      turn_id: string;
      status: string;
      terminal_detail_json: string | null;
    } | null;
    if (!row) return undefined;
    const detail = row.terminal_detail_json
      ? (JSON.parse(row.terminal_detail_json) as { error?: string })
      : undefined;
    return {
      id: row.turn_id,
      status: row.status,
      ...(detail?.error ? { error: detail.error } : {}),
    };
  }

  turnStatus(turnId: string): string | undefined {
    return (
      this.database.query("SELECT status FROM turns WHERE turn_id = ?").get(turnId) as {
        status: string;
      } | null
    )?.status;
  }

  close(): void {
    this.database.close();
  }
}

const MESSAGE_SELECT =
  "SELECT m.*, t.status AS turn_status FROM messages m JOIN turns t ON t.turn_id = m.turn_id";
type MessageRow = {
  message_id: string;
  ordinal: number;
  role: RemoteMessage["role"];
  content: string | null;
  turn_id: string;
  turn_status: string;
  created_at: string;
  name: string | null;
  tool_call_id: string | null;
  tool_calls_json: string | null;
};
function projectMessage(row: MessageRow): RemoteMessage {
  return {
    id: row.message_id,
    ordinal: row.ordinal,
    role: row.role,
    text: row.content ?? "",
    turnId: row.turn_id,
    turnStatus: row.turn_status,
    createdAt: row.created_at,
    ...(row.name ? { name: row.name } : {}),
    ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
    ...(row.tool_calls_json
      ? {
          toolCalls: decodeStoredToolCalls(row.tool_calls_json).map((call) => ({
            id: call.toolCallId,
            name: call.name,
            arguments: JSON.stringify(call.args),
          })),
        }
      : {}),
  };
}
