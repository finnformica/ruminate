import type { SqlDriver, SqlValue } from "../src/data/sql-driver"

/**
 * A `SqlDriver` over a D1 database — the control-plane engine. The tenancy
 * resolver (`handlers/tenancy.ts`) and the tenant-#1 corpus export
 * (`handlers/corpus-migration.ts`) run through this seam so their logic stays
 * engine-agnostic and testable on `node:sqlite`.
 */
export function createD1SqlDriver(db: D1Database): SqlDriver {
  return {
    exec: async (sql, params = []) => {
      const result = await db
        .prepare(sql)
        .bind(...params)
        .all()
      return result.results as Record<string, SqlValue>[]
    },
    batch: async (statements) => {
      // D1 runs a batch as a single implicit transaction: all or nothing.
      await db.batch(statements.map((s) => db.prepare(s.sql).bind(...(s.params ?? []))))
    },
    execScript: async (sql) => {
      await db.exec(sql)
    },
    close: () => Promise.resolve(),
  }
}
