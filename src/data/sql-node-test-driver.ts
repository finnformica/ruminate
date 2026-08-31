import type * as nodeSqlite from "node:sqlite"
import type { SqlDriver, SqlValue } from "./sql-driver"

// `node:sqlite` is a prefix-only builtin, which the vite/node-polyfills
// pipeline does not recognize (it strips `node:` and looks for a plain
// `sqlite` module) — so a static import fails to resolve under vitest.
// `process.getBuiltinModule` (Node >= 22.3) loads it at runtime, entirely
// outside the transform; the type comes from a type-only import, which is
// erased before vite ever sees it.
const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
const sqlite = proc?.getBuiltinModule?.("node:sqlite") as typeof nodeSqlite | undefined
if (!sqlite) throw new Error("node:sqlite is unavailable — tests require Node >= 22.5")
const { DatabaseSync } = sqlite

/**
 * A `SqlDriver` over `node:sqlite`'s synchronous in-memory database — the test
 * engine behind the conformance suite. The SQL store runs the exact same
 * statements here that the wasm worker runs in the browser, with no native
 * devDependency and no wasm loading in node.
 */
export function createNodeSqlDriver(): SqlDriver {
  const db = new DatabaseSync(":memory:")
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
    close: () => {
      db.close()
      return Promise.resolve()
    },
  }
}
