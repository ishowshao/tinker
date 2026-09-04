import type { Database } from "bun:sqlite";

export function runTransaction<T>(database: Database, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the mutation error; the session will fault and close the database.
    }
    throw error;
  }
}

export function requireSingleChange(
  database: Database,
  reportedChanges: number | bigint,
  operation: string,
): void {
  const row = database.query("SELECT changes() AS changes").get() as {
    changes: number | bigint;
  };
  if (Number(row.changes) !== 1) {
    throw new Error(
      `${operation} must change exactly one row; changed ${row.changes} (driver reported ${reportedChanges}).`,
    );
  }
}

export function requireItem<T>(items: readonly T[], index: number, name: string): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`Missing ${name} at index ${index}.`);
  }
  return item;
}
