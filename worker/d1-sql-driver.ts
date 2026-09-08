import type { SqlDriver, SqlValue } from "../src/data/sql-driver"

/**
 * A `SqlDriver` over a D1 database — the control-plane engine. The tenancy
 * resolver (`handlers/tenancy.ts`) and the tenant-#1 corpus export
 * (`handlers/corpus-migration.ts`) run through this seam so their logic stays
 * engine-agnostic and testable on `node:sqlite`.
 */

/**
 * Rows a single statement may read before it is logged as a regression.
 *
 * D1's free tier allows 5M `rows_read` per day, and the way that budget gets
 * spent is not a busy app — it is one query whose cost scales with the corpus
 * running on an ambient browser event. In 2026-09 the diagnostics status query
 * counted links with `IN (SELECT … FROM nodes)`, read 76k rows per call on a
 * ~520-row corpus, ran after every push, and consumed 6.25M rows in a day —
 * 97% of the account's entire read volume, from one person taking notes
 * (docs/scaling-thresholds.md).
 *
 * Every healthy statement here reads at most the tenant's own corpus once: the
 * full pull, the largest of them, was measured at ~540 rows. 5,000 is roughly
 * ten times that — high enough to stay silent through years of ordinary corpus
 * growth, low enough that anything quadratic trips it on the first request.
 * It is a smoke alarm, not a quota: crossing it means the SHAPE of a query is
 * wrong, which is why the log carries the SQL.
 */
const ROWS_READ_WARN = 5_000

/** The slice of `D1Meta` this module reads. Structural, so the worker test
 * suites (which drive `SqlDriver` over `node:sqlite`) need not supply one. */
interface QueryMeta {
  rows_read?: number
  rows_written?: number
  duration?: number
}

/**
 * Log any statement that reads more rows than a whole corpus. One line of
 * JSON per event, picked up by Workers observability (enabled in
 * wrangler.jsonc) — no sampling, because the event should never happen.
 */
function auditRowsRead(sql: string, meta: QueryMeta | undefined): void {
  const rowsRead = meta?.rows_read ?? 0
  if (rowsRead < ROWS_READ_WARN) return
  console.warn(
    JSON.stringify({
      event: "d1_expensive_query",
      rows_read: rowsRead,
      rows_written: meta?.rows_written ?? 0,
      duration_ms: meta?.duration ?? 0,
      // Enough to identify the statement without dumping a full-corpus
      // payload into the logs; these queries are written out in full in
      // `handlers/replica-corpus.ts` and are recognisable from their opening.
      sql: sql.replace(/\s+/g, " ").slice(0, 200),
    }),
  )
}

export function createD1SqlDriver(db: D1Database): SqlDriver {
  return {
    exec: async (sql, params = []) => {
      const result = await db
        .prepare(sql)
        .bind(...params)
        .all()
      auditRowsRead(sql, result.meta as QueryMeta | undefined)
      return result.results as Record<string, SqlValue>[]
    },
    batch: async (statements) => {
      // D1 runs a batch as a single implicit transaction: all or nothing.
      const results = await db.batch(
        statements.map((s) => db.prepare(s.sql).bind(...(s.params ?? []))),
      )
      // Each statement reports its own meta; a batch is the write path, so a
      // read blow-up here would be a lookup inside a write plan.
      results.forEach((result, index) =>
        auditRowsRead(statements[index].sql, result.meta as QueryMeta | undefined),
      )
    },
    execScript: async (sql) => {
      await db.exec(sql)
    },
    close: () => Promise.resolve(),
  }
}
