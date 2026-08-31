import type { SqlDriver } from "./sql-driver"

/**
 * The corpus schema ladder — one dialect, three engines. The same
 * `migrations/*.sql` files initialize every engine that holds a corpus:
 *
 * - the browser sqlite-wasm store and the `node:sqlite` test driver, via
 *   `openSqlNoteStore` (`sql-note-store.ts`, Vite `?raw` imports),
 * - the per-user `UserCorpus` Durable Object (`worker/corpus-do.ts`, wrangler
 *   Text-rule imports),
 * - the control-plane D1 database applies the same files through
 *   `wrangler d1 migrations apply` (its corpus tables are legacy — tenant #1's
 *   pre-multi-tenant rows — but the DDL is identical by construction).
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
}

const CORPUS_SCHEMA_VERSION = "2"

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

/**
 * Bring `driver`'s database to the current corpus schema: apply the full
 * migration ladder when empty, migrate a v1 database in place via `0002`, and
 * reset-and-rebuild anything unrecognized.
 */
export async function ensureCorpusSchema(
  driver: SqlDriver,
  migrations: CorpusMigrations,
): Promise<void> {
  const full = migrations.init + "\n" + migrations.nodes
  const tables = await driver.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
  )
  if (tables.length === 0) {
    await driver.execScript(full)
    return
  }
  const rows = await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")
  const version = rows[0]?.value
  if (version === "1") {
    await driver.execScript(migrations.nodes)
  } else if (version !== CORPUS_SCHEMA_VERSION) {
    await driver.execScript(RESET_SQL + full)
  }
}
