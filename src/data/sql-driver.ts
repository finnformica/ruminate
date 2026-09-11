/**
 * The thin seam between the SQL `NoteStore` and an actual SQLite engine.
 *
 * Two implementations exist:
 * - `sql-driver-browser.ts` — the official `@sqlite.org/sqlite-wasm` build
 *   running in a dedicated Web Worker with the OPFS `opfs-sahpool` VFS
 *   (persistent, no COOP/COEP headers required), falling back to an in-memory
 *   database when OPFS is unavailable.
 * - `sql-node-test-driver.ts` — `node:sqlite`'s `DatabaseSync`, so the store
 *   tests run the exact same SQL without a native devDependency or wasm
 *   loading in vitest.
 *
 * Keeping the seam this small (exec / batch / script / close) is what lets the
 * same store run unchanged on both engines.
 */

export type SqlValue = string | number | null

export interface SqlStatement {
  sql: string
  params?: SqlValue[]
}

export interface SqlDriver {
  /** Run one statement, returning result rows as plain objects. */
  exec(sql: string, params?: SqlValue[]): Promise<Record<string, SqlValue>[]>
  /** Run a batch of statements atomically — one transaction, all or nothing. */
  batch(statements: SqlStatement[]): Promise<void>
  /** Run a multi-statement SQL script (migrations). */
  execScript(sql: string): Promise<void>
  close(): Promise<void>
}
