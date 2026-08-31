// Test-only engine for the worker suites: a `SqlDriver` over `node:sqlite`,
// plus a D1-shaped facade over it.
//
// This deliberately duplicates the *loading* trick of
// `src/data/sql-node-test-driver.ts` instead of importing it: that module has
// `import type * as nodeSqlite from "node:sqlite"`, which `check:worker`
// (compiled against workers-types only, no node types) cannot resolve — so
// the minimal surface is hand-typed here, the same pattern `replica.test.ts`
// has always used.

import type { SqlDriver, SqlValue } from "../../src/data/sql-driver"

interface SqliteStatement {
  run(...params: (string | number | null)[]): unknown
  all(...params: (string | number | null)[]): Record<string, unknown>[]
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement
  exec(sql: string): void
}
const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
const sqlite = proc?.getBuiltinModule?.("node:sqlite") as
  { DatabaseSync: new (path: string) => SqliteDatabase } | undefined

/** An in-memory real-SQLite `SqlDriver` — the engine behind the worker-side
 * conformance tests (tenancy, corpus ops, migration, routing). */
export function createTestSqlDriver(): SqlDriver {
  if (!sqlite) throw new Error("node:sqlite is unavailable — tests require Node >= 22.5")
  const db = new sqlite.DatabaseSync(":memory:")
  return {
    exec: (sql, params = []) => {
      const statement = db.prepare(sql)
      if (/^\s*select/i.test(sql)) {
        return Promise.resolve(statement.all(...params) as Record<string, SqlValue>[])
      }
      statement.run(...params)
      return Promise.resolve([])
    },
    batch: (statements) => {
      db.exec("BEGIN")
      try {
        for (const { sql, params = [] } of statements) {
          db.prepare(sql).run(...params)
        }
        db.exec("COMMIT")
      } catch (error) {
        db.exec("ROLLBACK")
        throw error
      }
      return Promise.resolve()
    },
    execScript: (sql) => {
      db.exec(sql)
      return Promise.resolve()
    },
    close: () => Promise.resolve(),
  }
}

/**
 * Wrap a `SqlDriver` in just enough of the `D1Database` surface for
 * `createD1SqlDriver` (worker/d1-sql-driver.ts) to run against it — so tests
 * drive the exact production code path (`requireSession` → `resolveTenancy`,
 * the migration export) with a real SQL engine behind the fake binding.
 */
export function asFakeD1(driver: SqlDriver): D1Database {
  interface FakeStatement {
    bind(...params: SqlValue[]): FakeStatement
    all(): Promise<{ results: Record<string, SqlValue>[] }>
    first(): Promise<Record<string, SqlValue> | null>
    run(): Promise<unknown>
  }
  const prepare = (sql: string): FakeStatement => {
    const withParams = (params: SqlValue[]): FakeStatement => ({
      bind: (...next: SqlValue[]) => withParams(next),
      all: async () => ({ results: await driver.exec(sql, params) }),
      first: async () => (await driver.exec(sql, params))[0] ?? null,
      run: async () => {
        await driver.exec(sql, params)
        return {}
      },
    })
    return withParams([])
  }
  const fake = {
    prepare,
    batch: (statements: FakeStatement[]) =>
      Promise.all(statements.map((statement) => statement.run())),
    exec: (sql: string) => driver.execScript(sql),
  }
  return fake as unknown as D1Database
}
