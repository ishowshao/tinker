import { describe, expect, test } from "bun:test";
import { ScopedQueryDatabase } from "../session/scoped-query-database";

const QUERY_COUNT = 25; // Exceeds the pinned Bun runtime's 20-statement cache.

describe("ScopedQueryDatabase", () => {
  test("closes with live statements beyond Bun's query cache without waiting for GC", () => {
    const database = new ScopedQueryDatabase(":memory:");
    // Keep strong references so this test cannot pass through incidental GC.
    const statements = Array.from({ length: QUERY_COUNT }, (_, index) =>
      database.query<{ value: number }, [number]>(`SELECT ? AS value /* ${index} */`),
    );
    try {
      for (const statement of statements) {
        expect(statement.get(42)).toEqual({ value: 42 });
      }
      expect(() => database.close()).not.toThrow();
      for (const statement of statements) {
        expect(() => statement.get(42)).toThrow();
      }
      expect(() => database.close()).not.toThrow();
    } finally {
      for (const statement of statements) statement.finalize();
      database.close();
    }
  });

  test("rolls back a failed read transaction and closes its uncached statements", () => {
    const database = new ScopedQueryDatabase(":memory:");
    const cancelled = new Error("cancelled after reading");
    const read = database.transaction(() => {
      for (let index = 0; index < QUERY_COUNT; index++) {
        database.query(`SELECT ${index}`).get();
      }
      throw cancelled;
    });
    try {
      expect(read).toThrow(cancelled);
      expect(database.inTransaction).toBe(false);
      expect(() => database.close()).not.toThrow();
    } finally {
      database.close();
    }
  });
});
