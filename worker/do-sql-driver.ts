import type { SqlDriver, SqlValue } from "../src/data/sql-driver"

/**
 * A `SqlDriver` over a Durable Object's private SQLite database
 * (`ctx.storage.sql`) — the third engine behind the seam, after the browser
 * sqlite-wasm store and the `node:sqlite` test driver. This adapter is the
 * whole of what `UserCorpus` adds over the shared, platform-neutral corpus
 * code (docs/multi-tenant-design.md §10): every query and plan it runs comes
 * from `handlers/replica-corpus.ts` / `replica-payload.ts` unchanged.
 *
 * `SqlStorage` is synchronous, so every method resolves immediately; `batch`
 * uses `transactionSync` for the same all-or-nothing semantics `db.batch`
 * gives the D1 driver and BEGIN/COMMIT gives the test driver.
 */
export function createDoSqlDriver(storage: DurableObjectStorage): SqlDriver {
  const sql = storage.sql
  return {
    exec: (query, params = []) =>
      Promise.resolve(sql.exec(query, ...params).toArray() as Record<string, SqlValue>[]),
    batch: (statements) => {
      storage.transactionSync(() => {
        for (const statement of statements) {
          sql.exec(statement.sql, ...(statement.params ?? []))
        }
      })
      return Promise.resolve()
    },
    execScript: (script) => {
      // Multi-statement strings are allowed when there are no bindings —
      // exactly the migration-script case.
      sql.exec(script)
      return Promise.resolve()
    },
    close: () => Promise.resolve(),
  }
}
