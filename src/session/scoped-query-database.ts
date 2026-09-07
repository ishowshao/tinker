import { Database, type SQLQueryBindings } from "bun:sqlite";

/**
 * Own every query statement until a short-lived connection closes. Bun only
 * caches its first 20 queries; later statements otherwise survive close() until
 * GC, leaving a zombie SQLite connection behind. Do not use this for resident
 * stores: retaining every query is intentionally bounded by the operation.
 */
export class ScopedQueryDatabase extends Database {
  private readonly queries = new Set<{ finalize(): void }>();

  override query<Result, Params extends SQLQueryBindings | SQLQueryBindings[]>(
    sql: string,
  ) {
    const statement = super.query<Result, Params>(sql);
    this.queries.add(statement);
    return statement;
  }

  override close(): void {
    for (const statement of this.queries) statement.finalize();
    this.queries.clear();
    // Also finalizes Bun's transaction statements and rejects any other live
    // resources instead of silently deferring the underlying connection close.
    super.close(true);
  }
}
