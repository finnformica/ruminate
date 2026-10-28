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
  /** migrations/0005_row_seq.sql — required in `"columns"` mode. The local
   * store has no `seq`: the sequence is assigned by the replica, and a cache
   * has no ordering of its own to keep. */
  rowSeq?: string
  /** migrations/0006_notes_id.sql — required in `"columns"` mode. The local store
   * gains the column without the backfill (`LOCAL_V4_SQL`): a cache re-pulls
   * the note ids the replica computed. */
  notesId?: string
  /** migrations/0015_views.sql — required in `"columns"` mode. The local store
   * gets the table without the backfill (`LOCAL_V5_SQL`): a cache re-pulls the
   * view rows the replica holds. */
  views?: string
  /** migrations/0016: the three view keys retired from node props — a data
   * migration, so the local ladder only bumps its version and the cache
   * re-pulls (`LOCAL_V6_SQL`). */
  retireViewProps?: string
  /** migrations/0020: a board's root retyped from `note` with a `board` prop
   * to `board` — a data migration, so the local ladder only bumps its
   * version and the cache re-pulls (`LOCAL_V7_SQL`). */
  boardType?: string
  /** migrations/0021: a pinned view row for every note and board — a data
   * migration, so the local ladder only bumps its version and the cache
   * re-pulls (`LOCAL_V8_SQL`). */
  noteViews?: string
  /** migrations/0023: the event log — required in `"columns"` mode. The
   * local store gets its own, single-tenant log (`LOCAL_V9_SQL`): the events
   * this device made, pushed from there. */
  events?: string
  /** migrations/0024: the stamp column on the event log — required in
   * `"columns"` mode. The local store adds the same column (`LOCAL_V11_SQL`). */
  eventHlc?: string
  /** migrations/0027: a View's saved stack — required in `"columns"` mode. The
   * local store adds the same column (`LOCAL_V14_SQL`). */
  viewStack?: string
  /** migrations/0028: the per-key event log and `delta_mat_values` — required in
   * `"columns"` mode. The local store gets its own, single-tenant pair
   * (`LOCAL_V15_SQL`). */
  eventsLog?: string
}

/** Which v3 shape the ladder should produce (see the module header). */
export type CorpusTenancy = "single" | "columns"

const CORPUS_SCHEMA_VERSION = 15

/**
 * The single-tenant v5 step: the `views` table (migrations/0015) — the
 * entrypoints into the graph, as rows. No `user_id` for the same reason
 * nothing else here has one, and no backfill: the local store is a cache, so
 * the rows the replica backfilled arrive with the next pull
 * (`CACHE_GENERATION`, database-mode.ts).
 */
const LOCAL_V5_SQL = `
CREATE TABLE views (
  id         TEXT PRIMARY KEY,
  root_id    TEXT NOT NULL,
  filter     TEXT,
  sort       TEXT,
  pinned     INTEGER NOT NULL DEFAULT 0,
  sort_key   TEXT,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX views_root ON views (root_id);
CREATE INDEX views_pinned ON views (pinned, sort_key);
INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '5');
`

/**
 * The single-tenant v6 step: nothing but the version. migrations/0016 is a
 * data migration — it retires the three view keys from node props — and
 * data migrations run once, against D1; the local store is a cache and
 * re-pulls the cleaned rows (`CACHE_GENERATION`, database-mode.ts).
 */
const LOCAL_V6_SQL = `
INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '6');
`

/**
 * The single-tenant v7 step: nothing but the version. migrations/0020 is a
 * data migration — it retypes every board's root from `note` to `board` —
 * and data migrations run once, against D1; the local store is a cache and
 * re-pulls the retyped rows (`CACHE_GENERATION`, database-mode.ts).
 */
const LOCAL_V7_SQL = `
INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '7');
`

/**
 * The single-tenant v8 step: nothing but the version. migrations/0021 is a
 * data migration — it gives every note and board a pinned view row — and
 * data migrations run once, against D1; the local store is a cache and
 * re-pulls the rows (`CACHE_GENERATION`, database-mode.ts).
 */
const LOCAL_V8_SQL = `
INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '8');
`

/**
 * The single-tenant v9 step: the device's own event log, and `seq` on the
 * cached rows (docs/event-sourcing.md).
 *
 * `events` holds the tenant's log as this device knows it. What THIS device
 * did — every op the editor applied, as the events it amounts to
 * (`opsToEvents`) — goes in as made, and is the push queue: a row with `seq`
 * NULL has not reached the replica yet, and survives a reload where the
 * in-memory queue it replaces did not; `seq` is stamped from the replica's
 * answer when the push lands.
 *
 * `seq` on `nodes`, `link` and `views` is the replica's sequence for the row
 * as last pulled — what an edit made here believed it was changing
 * (`base_seq`). The cache never assigns one.
 *
 * This is the table exactly as the step first shipped. A step that has
 * reached a device is never edited: the ladder runs each step once, keyed by
 * the version it leaves behind, so a column added to this text afterwards
 * would exist on fresh databases and be missing from every device that ran
 * the step before the edit — which is what happened the day v9 shipped, and
 * is what v10 repairs.
 */
const LOCAL_V9_SQL = `
ALTER TABLE nodes ADD COLUMN seq INTEGER;
ALTER TABLE link ADD COLUMN seq INTEGER;
ALTER TABLE views ADD COLUMN seq INTEGER;
CREATE TABLE events (
  id         TEXT PRIMARY KEY,
  seq        INTEGER,
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  action     TEXT NOT NULL,
  patch      TEXT NOT NULL,
  v          INTEGER NOT NULL,
  batch      TEXT NOT NULL,
  device     TEXT NOT NULL,
  cause      TEXT,
  base_seq   INTEGER,
  ref_seq    INTEGER,
  at         INTEGER NOT NULL,
  tz         INTEGER,
  position   INTEGER NOT NULL
);
CREATE INDEX events_unpushed ON events (seq, position);
INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '9');
`

/**
 * The single-tenant v10 step: what every other writer did, in the device's
 * log. Those events arrive by the events pull (`GET /api/replica/events?since=`),
 * placed, with who wrote them (`origin`, `actor`) and when the replica took
 * them (`received_at`). The rows are still refreshed by the pull of rows; the
 * log is for history — a day on the calendar is a fold of it.
 *
 * Three nullable columns, so the device's unpushed events survive the step
 * untouched. The columns were first added by editing the v9 text in place,
 * the day after it shipped; a device that opened the app between the two
 * deploys was left at v9 without them, and every pull since failed on the
 * first event it tried to place. This step brings those devices level.
 */
const LOCAL_V10_SQL = `
ALTER TABLE events ADD COLUMN origin TEXT;
ALTER TABLE events ADD COLUMN actor INTEGER;
ALTER TABLE events ADD COLUMN received_at INTEGER;
INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '10');
`

/**
 * The single-tenant v11 step: each event's stamp (`EventEnvelope.hlc`,
 * docs/event-only-sync.md). One nullable column, so every event already in
 * the log stays as it was: an event without a stamp gets one derived when it
 * is read (`eventStamp`), never written back.
 */
const LOCAL_V11_SQL = `
ALTER TABLE events ADD COLUMN hlc TEXT;
INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '11');
`

/**
 * The single-tenant v12 step: snapshots of the fold by stamp, which v13
 * drops again (the cache replaced them, docs/event-sourcing.md). Each row was the encoded
 * state and the log `position` it covers; the store keeps the 2 newest, and
 * `id` orders them. The index serves the tail past a snapshot's position, and
 * the next position an append takes. The D1 shape has no snapshots: the
 * replica's tables are its state.
 */
const LOCAL_V12_SQL = `
CREATE TABLE snapshots (
  id       INTEGER PRIMARY KEY,
  position INTEGER NOT NULL,
  taken_at INTEGER NOT NULL,
  state    TEXT NOT NULL
);
CREATE INDEX events_position ON events (position);
INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '12');
`

/**
 * The single-tenant v13 step: the tables become a cache of the fold
 * (docs/event-only-sync.md, "The cache"). Each row keeps the stamp of each
 * field (`stamps`, as the server's migrations/0025 does), and the fold check
 * reads one entity's events by the new index. The snapshots go: the cache
 * replaces them. The rows keep their values; the store fills their stamps
 * once (`fillStampsStatements`, a `meta` flag), since this ladder is DDL
 * only. The D1 shape has its own `stamps` (0025) and no snapshots.
 */
const LOCAL_V13_SQL = `
ALTER TABLE nodes ADD COLUMN stamps TEXT;
ALTER TABLE link ADD COLUMN stamps TEXT;
ALTER TABLE views ADD COLUMN stamps TEXT;
DROP TABLE IF EXISTS snapshots;
CREATE INDEX events_entity ON events (entity, entity_id);
INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '13');
`

/**
 * The single-tenant v14 step: a View's saved stack (migrations/0027,
 * docs/graph-walk.md, "Views save stacks"). One nullable column: NULL is a
 * one-frame View, which is every row the store holds before it.
 */
const LOCAL_V14_SQL = `
ALTER TABLE views ADD COLUMN stack TEXT;
INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '14');
`

/**
 * The single-tenant v15 step: the per-key event log and the per-key read
 * model of a block's props (migrations/0028, docs/event-sourcing.md,
 * "Per-key events"). `events_log` is the device's log in the new shape —
 * what this device did, one row per key, the push queue (`seq` NULL until
 * placed), and everyone else's rows by the events pull; `event_seq` is the
 * old log's seq of the event a row mirrors, the order the row cursors count
 * in. `delta_mat_values` mirrors the replica's read model, written beside each
 * block's cache row. The old `events` table stays as it is, unread. The
 * cache re-pulls (`CACHE_GENERATION`, database-mode.ts): its rows must hold
 * a stamp per key.
 */
const LOCAL_V15_SQL = `
CREATE TABLE events_log (
  id          TEXT PRIMARY KEY,
  seq         INTEGER,
  entity      TEXT NOT NULL CHECK (entity IN ('block', 'link', 'view')),
  entity_id   TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('create', 'set', 'unset', 'delete', 'restore')),
  key         TEXT NOT NULL CHECK (
                CASE WHEN action IN ('set', 'unset')
                  THEN key GLOB '[A-Za-z_]*'
                    AND key NOT GLOB '*[^A-Za-z0-9_.:-]*'
                    AND length(key) <= 134
                  ELSE key = ''
                END),
  value       TEXT NOT NULL CHECK (json_valid(value)),
  v           INTEGER NOT NULL DEFAULT 2,
  batch       TEXT NOT NULL,
  device      TEXT NOT NULL,
  cause       TEXT,
  base_seq    INTEGER,
  ref_seq     INTEGER,
  at          INTEGER NOT NULL,
  tz          INTEGER,
  hlc         TEXT,
  origin      TEXT,
  actor       INTEGER,
  received_at INTEGER,
  event_id    TEXT,
  event_seq   INTEGER,
  position    INTEGER NOT NULL
);
CREATE INDEX events_log_unpushed ON events_log (seq, position);
CREATE INDEX events_log_entity ON events_log (entity, entity_id);
CREATE TABLE delta_mat_values (
  block_id   TEXT NOT NULL,
  key        TEXT NOT NULL CHECK (
               key GLOB '[A-Za-z_]*'
               AND key NOT GLOB '*[^A-Za-z0-9_.:-]*'
               AND length(key) <= 128),
  value      TEXT CHECK (value IS NULL OR json_valid(value)),
  hlc        TEXT NOT NULL,
  seq        INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (block_id, key)
);
INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '15');
`

/**
 * The single-tenant v4 step: `notes_id` on nodes (migrations/0006) and nothing
 * else — no backfill, because the local store is a cache and re-pulls the
 * note ids the replica computed (`CACHE_GENERATION`, database-mode.ts).
 */
const LOCAL_V4_SQL = `
ALTER TABLE nodes ADD COLUMN notes_id TEXT;
INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '4');
`

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
DROP TABLE IF EXISTS delta_mat_values;
DROP TABLE IF EXISTS events_log;
DROP TABLE IF EXISTS snapshots;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS views;
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
  if (!migrations.rowSeq) {
    throw new Error('ensureCorpusSchema: "columns" tenancy needs migrations.rowSeq (0005)')
  }
  await driver.execScript(migrations.rowSeq)
}

async function applyV4(
  driver: SqlDriver,
  migrations: CorpusMigrations,
  tenancy: CorpusTenancy,
): Promise<void> {
  if (tenancy === "single") {
    await driver.execScript(LOCAL_V4_SQL)
    return
  }
  if (!migrations.notesId) {
    throw new Error('ensureCorpusSchema: "columns" tenancy needs migrations.notesId (0006)')
  }
  await driver.execScript(migrations.notesId)
}

async function applyV5(
  driver: SqlDriver,
  migrations: CorpusMigrations,
  tenancy: CorpusTenancy,
): Promise<void> {
  if (tenancy === "single") {
    await driver.execScript(LOCAL_V5_SQL)
    return
  }
  if (!migrations.views) {
    throw new Error('ensureCorpusSchema: "columns" tenancy needs migrations.views (0015)')
  }
  await driver.execScript(migrations.views)
}

async function applyV6(
  driver: SqlDriver,
  migrations: CorpusMigrations,
  tenancy: CorpusTenancy,
): Promise<void> {
  if (tenancy === "single") {
    await driver.execScript(LOCAL_V6_SQL)
    return
  }
  if (!migrations.retireViewProps) {
    throw new Error('ensureCorpusSchema: "columns" tenancy needs migrations.retireViewProps (0016)')
  }
  await driver.execScript(migrations.retireViewProps)
}

async function applyV7(
  driver: SqlDriver,
  migrations: CorpusMigrations,
  tenancy: CorpusTenancy,
): Promise<void> {
  if (tenancy === "single") {
    await driver.execScript(LOCAL_V7_SQL)
    return
  }
  if (!migrations.boardType) {
    throw new Error('ensureCorpusSchema: "columns" tenancy needs migrations.boardType (0020)')
  }
  await driver.execScript(migrations.boardType)
}

async function applyV8(
  driver: SqlDriver,
  migrations: CorpusMigrations,
  tenancy: CorpusTenancy,
): Promise<void> {
  if (tenancy === "single") {
    await driver.execScript(LOCAL_V8_SQL)
    return
  }
  if (!migrations.noteViews) {
    throw new Error('ensureCorpusSchema: "columns" tenancy needs migrations.noteViews (0021)')
  }
  await driver.execScript(migrations.noteViews)
}

async function applyV9(
  driver: SqlDriver,
  migrations: CorpusMigrations,
  tenancy: CorpusTenancy,
): Promise<void> {
  if (tenancy === "single") {
    await driver.execScript(LOCAL_V9_SQL)
    return
  }
  if (!migrations.events) {
    throw new Error('ensureCorpusSchema: "columns" tenancy needs migrations.events (0023)')
  }
  await driver.execScript(migrations.events)
}

async function applyV10(driver: SqlDriver, tenancy: CorpusTenancy): Promise<void> {
  // The D1 shape has carried the three columns since 0023: nothing to do there.
  if (tenancy === "single") await driver.execScript(LOCAL_V10_SQL)
}

async function applyV11(
  driver: SqlDriver,
  migrations: CorpusMigrations,
  tenancy: CorpusTenancy,
): Promise<void> {
  if (tenancy === "single") {
    await driver.execScript(LOCAL_V11_SQL)
    return
  }
  if (!migrations.eventHlc) {
    throw new Error('ensureCorpusSchema: "columns" tenancy needs migrations.eventHlc (0024)')
  }
  await driver.execScript(migrations.eventHlc)
}

async function applyV12(driver: SqlDriver, tenancy: CorpusTenancy): Promise<void> {
  if (tenancy === "single") await driver.execScript(LOCAL_V12_SQL)
}

async function applyV13(driver: SqlDriver, tenancy: CorpusTenancy): Promise<void> {
  if (tenancy === "single") await driver.execScript(LOCAL_V13_SQL)
}

async function applyV14(
  driver: SqlDriver,
  migrations: CorpusMigrations,
  tenancy: CorpusTenancy,
): Promise<void> {
  if (tenancy === "single") {
    await driver.execScript(LOCAL_V14_SQL)
    return
  }
  if (!migrations.viewStack) {
    throw new Error('ensureCorpusSchema: "columns" tenancy needs migrations.viewStack (0027)')
  }
  await driver.execScript(migrations.viewStack)
}

async function applyV15(
  driver: SqlDriver,
  migrations: CorpusMigrations,
  tenancy: CorpusTenancy,
): Promise<void> {
  if (tenancy === "single") {
    await driver.execScript(LOCAL_V15_SQL)
    return
  }
  if (!migrations.eventsLog) {
    throw new Error('ensureCorpusSchema: "columns" tenancy needs migrations.eventsLog (0028)')
  }
  await driver.execScript(migrations.eventsLog)
}

/**
 * Every local step that has shipped, by the version it leaves behind — for
 * `corpus-schema.test.ts`, which pins a hash of each. A step that has reached
 * a device cannot be edited without that test failing; the next change to
 * the schema is the next step.
 */
export const SHIPPED_LOCAL_STEPS: Readonly<Record<number, string>> = {
  3: LOCAL_V3_SQL,
  4: LOCAL_V4_SQL,
  5: LOCAL_V5_SQL,
  6: LOCAL_V6_SQL,
  7: LOCAL_V7_SQL,
  8: LOCAL_V8_SQL,
  9: LOCAL_V9_SQL,
  10: LOCAL_V10_SQL,
  11: LOCAL_V11_SQL,
  12: LOCAL_V12_SQL,
  13: LOCAL_V13_SQL,
  14: LOCAL_V14_SQL,
  15: LOCAL_V15_SQL,
}

type Step = (
  driver: SqlDriver,
  migrations: CorpusMigrations,
  tenancy: CorpusTenancy,
) => Promise<void>

/** Each step, keyed by the version it leaves the database at. A step runs
 * once per database and is never edited once it has shipped: the next change
 * to the schema is the next step, however small (see `LOCAL_V10_SQL`). */
const STEPS: readonly [number, Step][] = [
  [3, applyV3],
  [4, applyV4],
  [5, applyV5],
  [6, applyV6],
  [7, applyV7],
  [8, applyV8],
  [9, applyV9],
  [10, (driver, _migrations, tenancy) => applyV10(driver, tenancy)],
  [11, applyV11],
  [12, (driver, _migrations, tenancy) => applyV12(driver, tenancy)],
  [13, (driver, _migrations, tenancy) => applyV13(driver, tenancy)],
  [14, applyV14],
  [15, applyV15],
]

/**
 * Bring `driver`'s database to the current corpus schema: apply the full
 * migration ladder when empty, migrate a v1/v2/v3 database in place, and
 * reset-and-rebuild anything unrecognized.
 *
 * **DDL only.** This ladder creates tables; it never rewrites rows. Data
 * migrations run once, server-side, against D1 — the local store is a cache of
 * that corpus, so when its contents are of an older generation the runtime
 * discards them and re-pulls (`CACHE_GENERATION` in `database-mode.ts`) rather
 * than transforming them in place.
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
  const climb = async (from: number) => {
    for (const [version, step] of STEPS) if (version > from) await step(driver, migrations, tenancy)
  }
  if (tables.length === 0) {
    await driver.execScript(full)
    await climb(2)
    return
  }
  // In "columns" mode `meta` is keyed by (user_id, key), so this can see more
  // than one row — every tenant shares one DDL version, so any of them
  // answers the ladder's question.
  const rows = await driver.exec("SELECT value FROM meta WHERE key = 'schema_version' LIMIT 1")
  const version = Number(rows[0]?.value)
  if (version === 1) {
    await driver.execScript(migrations.nodes)
    await climb(2)
  } else if (Number.isInteger(version) && version >= 2 && version <= CORPUS_SCHEMA_VERSION) {
    await climb(version)
  } else {
    await driver.execScript(RESET_SQL + full)
    await climb(2)
  }
}
