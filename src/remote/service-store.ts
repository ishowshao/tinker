import { Database } from "bun:sqlite";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { stableJsonStringify, sha256 } from "../model/model-request-preflight";
import { parseSessionId } from "../ids/runtime-id";
import { SessionLease } from "../session/session-lock";
import {
  RemoteError,
  type RemoteOperationInput,
  type OperationReceipt,
  type RemoteSessionInfo,
} from "./protocol";

export type ManagedSessionRecord = RemoteSessionInfo & {
  workspacePath: string;
  initialized: boolean;
};
type ReceiptRow = {
  device: string;
  fingerprint: string;
  receipt: string;
  input: string;
};
const SERVICE_LEASE_ID = parseSessionId("00000000-0000-7000-8000-000000000001");

/** Durable acceptance receipts, separate from the canonical conversation databases. */
export class RemoteServiceStore {
  private constructor(
    private readonly db: Database,
    private readonly lease: SessionLease,
  ) {}

  static async open(directory: string): Promise<RemoteServiceStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const lease = await SessionLease.acquire({
      sessionDirectory: directory,
      sessionId: SERVICE_LEASE_ID,
    });
    let db: Database | undefined;
    try {
      const filename = path.join(directory, "remote.sqlite");
      db = new Database(filename, { create: true, strict: true });
      await chmod(filename, 0o600);
      db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
      );
      const version = (
        db.query("PRAGMA user_version").get() as { user_version: number }
      ).user_version;
      if (version !== 0 && version !== 1)
        throw new Error("Unsupported remote state schema.");
      db.exec(`CREATE TABLE IF NOT EXISTS managed_sessions (id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, device TEXT NOT NULL, fingerprint TEXT NOT NULL, input TEXT NOT NULL, receipt TEXT NOT NULL) STRICT;
        CREATE INDEX IF NOT EXISTS operations_session ON operations(session_id);
        PRAGMA user_version=1;`);
      const store = new RemoteServiceStore(db, lease);
      for (const row of db.query("SELECT receipt FROM operations").all() as {
        receipt: string;
      }[]) {
        const receipt = JSON.parse(row.receipt) as OperationReceipt;
        if (["accepted", "running", "waiting_input"].includes(receipt.status)) {
          store.update({
            ...receipt,
            status: "interrupted",
            error:
              "The local service process stopped. This request will not be replayed automatically.",
          });
        }
      }
      return store;
    } catch (error) {
      db?.close();
      await lease.release();
      throw error;
    }
  }

  sessions(): ManagedSessionRecord[] {
    return (
      this.db.query("SELECT record FROM managed_sessions").all() as { record: string }[]
    ).map((row) => JSON.parse(row.record) as ManagedSessionRecord);
  }
  session(id: string): ManagedSessionRecord | undefined {
    const row = this.db
      .query("SELECT record FROM managed_sessions WHERE id = ?")
      .get(id) as { record: string } | null;
    return row ? (JSON.parse(row.record) as ManagedSessionRecord) : undefined;
  }
  saveSession(record: ManagedSessionRecord): void {
    this.db
      .query(
        "INSERT INTO managed_sessions VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
      )
      .run(record.id, JSON.stringify(record));
  }
  existing(input: RemoteOperationInput, device: string): OperationReceipt | undefined {
    const row = this.db
      .query("SELECT * FROM operations WHERE id = ?")
      .get(input.requestId) as ReceiptRow | null;
    if (!row) return undefined;
    if (row.device !== device || row.fingerprint !== sha256(stableJsonStringify(input)))
      throw new RemoteError(
        409,
        "REQUEST_ID_REUSED",
        "This request ID was already used with different data or by another device.",
      );
    return JSON.parse(row.receipt) as OperationReceipt;
  }
  accept(
    input: RemoteOperationInput,
    device: string,
    sessionId: string,
    session?: ManagedSessionRecord,
  ): OperationReceipt {
    const now = new Date().toISOString();
    const receipt: OperationReceipt = {
      requestId: input.requestId,
      kind: input.kind,
      sessionId,
      status: "accepted",
      createdAt: now,
      updatedAt: now,
      ...(input.kind === "prompt" ? { prompt: input.prompt } : {}),
    };
    this.db.transaction(() => {
      this.db
        .query("INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          input.requestId,
          sessionId,
          device,
          sha256(stableJsonStringify(input)),
          JSON.stringify(input),
          JSON.stringify(receipt),
        );
      if (session) this.saveSession(session);
    })();
    return receipt;
  }
  get(id: string): OperationReceipt {
    const row = this.db
      .query("SELECT receipt FROM operations WHERE id = ?")
      .get(id) as { receipt: string } | null;
    if (!row)
      throw new RemoteError(
        404,
        "REQUEST_NOT_FOUND",
        "Request was not accepted by this service.",
      );
    return JSON.parse(row.receipt) as OperationReceipt;
  }
  operations(sessionId: string): OperationReceipt[] {
    return (
      this.db
        .query(
          "SELECT receipt FROM operations WHERE session_id = ? ORDER BY rowid DESC LIMIT 100",
        )
        .all(sessionId) as { receipt: string }[]
    )
      .reverse()
      .map((row) => JSON.parse(row.receipt) as OperationReceipt);
  }
  update(receipt: OperationReceipt): OperationReceipt {
    const next = { ...receipt, updatedAt: new Date().toISOString() };
    this.db
      .query("UPDATE operations SET receipt = ? WHERE id = ?")
      .run(JSON.stringify(next), receipt.requestId);
    return next;
  }
  async close(): Promise<void> {
    this.db.close();
    await this.lease.release();
  }
}
