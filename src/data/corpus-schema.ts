import { ensureDataVersion, singleTenantCorpus } from "./data-version"
import type { SqlDriver } from "./sql-driver"

/**
 * The corpus schema ladder — one dialect, two shapes, three engines. The same
 * `migrations/*.sql` files initialize every engine that holds a corpus:
 *
 * - the browser sqlite-wasm store and the `node:sqlite` test driver, via
 *   `openSqlNoteStore` (`sql-note-store.ts`, Vite `?raw` imports) — the
 *   **single-tenant** shape,
 * - the D1 database behind the Worker, via
 *   `wrangler d1 migrations apply ruminate` — the **column-tenanted** shape,
 *   where every corpus row carries `user_id` and every key leads with it.
 *
 * ## The one deliberate divergence (schema v3)
 *
 * v3 does two things at once: it adds `deleted_at` (soft deletes) to `nodes`
 * and `link` on **both** shapes, and it adds `user_id` — widening every
 * primary key and index — on the D1 shape **only**. The browser store is one
 * user per browser profile; there is no second tenant in an OPFS database, so
 * a `user_id` column there would be a constant. `tenancy` selects which v3
 * step runs:
 *
 * - `"single"` — `LOCAL_V3_SQL` below: two `ALTER TABLE … ADD COLUMN
 *   deleted_at`, nothing else. No table rebuild, because no key changes.
 * - `"columns"` — `migrations/0004_tenant_columns.sql`, the rebuild D1 runs.
 *
 * The `"columns"` mode exists so the worker test suites can build the exact
 * D1 shape on `node:sqlite` from the exact file D1 runs — the seam is pinned
 * by tests rather than asserted in prose. Production D1 never calls this
 * function (wrangler applies the ladder); production browsers only ever call
 * it in `"single"` mode.
 *
 * The migration *text* is passed in by the caller because each bundler has its
 * own way of importing a `.sql` file as a string; this module stays free of
 * both Vite-isms and wrangler-isms so all engines can share the ladder.
 */
export interface CorpusMigrations {
  /** migrations/0001_init.sql */
  init: string
  /** migrations/0002_nodes.sql */
  nodes: string
  /** migrations/0004_tenant_columns.sql — required in `"columns"` mode. */
  tenantColumns?: string
}

/** Which v3 shape the ladder should produce (see the module header). */
export type CorpusTenancy = "single" | "columns"

const CORPUS_SCHEMA_VERSION = "3"

/**
 * The single-tenant v3 step: soft-delete columns, and nothing else. Adding a
 * nullable column keeps every existing row live (`NULL` = live), so this needs
 * no table rebuild and no data copy.
 */
const LOCAL_V3_SQL = `
ALTER TABLE nodes ADD COLUMN deleted_at INTEGER;
ALTER TABLE link ADD COLUMN deleted_at INTEGER;
INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '3');
`

/** Drop everything either migration creates, so an incompatible schema can be
 * rebuilt from scratch — safe because a corpus can be re-pulled/re-pushed. */
const RESET_SQL = `
DROP TABLE IF EXISTS link;
DROP TABLE IF EXISTS nodes;
DROP TABLE IF EXISTS links;
DROP TABLE IF EXISTS blocks;
DROP TABLE IF EXISTS view_state;
DROP TABLE IF EXISTS notes;
DROP TABLE IF EXISTS meta;
`

async function applyV3(
  driver: SqlDriver,
  migrations: CorpusMigrations,
  tenancy: CorpusTenancy,
): Promise<void> {
  if (tenancy === "single") {
    await driver.execScript(LOCAL_V3_SQL)
    return
  }
  if (!migrations.tenantColumns) {
    throw new Error('ensureCorpusSchema: "columns" tenancy needs migrations.tenantColumns (0004)')
  }
  await driver.execScript(migrations.tenantColumns)
}

/**
 * Bring `driver`'s database to the current corpus schema: apply the full
 * migration ladder when empty, migrate a v1/v2 database in place, and
 * reset-and-rebuild anything unrecognized.
 *
 * After the DDL ladder, single-tenant engines also run the shared data-version
 * transform (`data-version.ts`) so rows whose *shape* predates the current
 * data version are rewritten on open. Column-tenanted corpora cannot: the
 * transform is per-tenant there, and the Worker runs it per verified user
 * (`ensureTenantDataVersion`, `worker/tenancy-db.ts`) instead.
 */
export async function ensureCorpusSchema(
  driver: SqlDriver,
  migrations: CorpusMigrations,
  tenancy: CorpusTenancy = "single",
): Promise<void> {
  const full = migrations.init + "\n" + migrations.nodes
  const tables = await driver.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
  )
  if (tables.length === 0) {
    await driver.execScript(full)
    await applyV3(driver, migrations, tenancy)
  } else {
    // In "columns" mode `meta` is keyed by (user_id, key), so this can see more
    // than one row — every tenant shares one DDL version, so any of them
    // answers the ladder's question.
    const rows = await driver.exec("SELECT value FROM meta WHERE key = 'schema_version' LIMIT 1")
    const version = rows[0]?.value
    if (version === "1") {
      await driver.execScript(migrations.nodes)
      await applyV3(driver, migrations, tenancy)
    } else if (version === "2") {
      await applyV3(driver, migrations, tenancy)
    } else if (version !== CORPUS_SCHEMA_VERSION) {
      await driver.execScript(RESET_SQL + full)
      await applyV3(driver, migrations, tenancy)
    }
  }
  if (tenancy === "single") await ensureDataVersion(singleTenantCorpus(driver))
}
