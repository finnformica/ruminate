import migration0001 from "../../migrations/0001_init.sql?raw"
import migration0002 from "../../migrations/0002_nodes.sql?raw"
import {
  toLinkRow,
  toNodeRow,
  toViewRow,
  type LinkRow,
  type NodeRow,
  type ViewRow,
} from "../../worker/handlers/replica-payload"
import { ensureCorpusSchema } from "./corpus-schema"
import {
  coalesceTyping,
  netChanges,
  type LoggedEvent,
  type NetChange,
  type RuminateEvent,
} from "./events"
import { buildGraphSnapshot } from "./graph"
import type { NoteStore } from "./note-store"
import type { SqlDriver, SqlStatement, SqlValue } from "./sql-driver"

/**
 * The SQL implementation of `NoteStore` — the store the app runs on, over the
 * schema v3 graph (docs/graph-schema-v2.md): `nodes` + `link` + `views` +
 * `meta`, and since v9 the device's own `events` (docs/event-sourcing.md).
 *
 * Backed by any `SqlDriver` (sqlite-wasm/OPFS in the browser, `node:sqlite` in
 * tests) and the exact migration files that initialize the D1 replica — in the
 * **single-tenant** shape (`corpus-schema.ts`): one user per browser profile,
 * so no `user_id` column, but the same `deleted_at` soft deletes the replica
 * has.
 *
 * **Events in, rows out.** A write arrives as the events the editor's ops
 * amount to (`opsToEvents`), and lands twice in one transaction: appended to
 * `events`, the device's log and its push queue, and applied to the rows the
 * way the replica applies the same events to its own (`planEventAppend`,
 * worker/handlers/event-log.ts) — a `create` inserts or revives, an `update`
 * sets what its patch names, a `delete` tombstones, a `restore` revives. Only
 * the rows an event names are written, each with the event's `at` as its
 * `updated_at`, which is what makes per-row LWW sync meaningful. The rows are
 * a cache of the replica's, refreshed by the pull; the log is this device's
 * account of what it did, pushed from here and stamped with the replica's
 * `seq` when the push lands.
 *
 * **Soft deletes.** Nothing here hard-deletes a corpus row. A delete stamps
 * `deleted_at` (and bumps `updated_at`, so the tombstone replicates like any
 * edit); every row a single write retires shares that write's one timestamp,
 * so a future restore is "revive the rows stamped at T". Reads discard
 * tombstones at read time — `loadMemGraph` loads only live rows and
 * `buildGraphSnapshot` drops links whose endpoints are gone — so deletes never
 * cascade at write time and a link to a deleted node survives as the position
 * a restore would put it back into.
 */

/**
 * Open a `NoteStore` on `driver`, applying the migrations when the database is
 * empty. A v1 database is migrated in place by `0002` (which drops the v1
 * tables — contents re-pull from the replica), a v2 one gains its soft-delete
 * columns, and anything else unrecognized is reset. The ladder itself lives in
 * `corpus-schema.ts`, shared with the D1 corpus.
 */
export async function openSqlNoteStore(driver: SqlDriver): Promise<NoteStore> {
  await ensureCorpusSchema(driver, { init: migration0001, nodes: migration0002 }, "single")

  return {
    getGraph: async () => {
      const mem = await loadMemGraph(driver)
      return buildGraphSnapshot(mem.nodes, mem.links)
    },

    applyEvents: async (events, options = {}) => {
      if (events.length === 0) return
      const frozen = options.frozen ?? new Set<string>()
      const unpushed = await loadUnpushed(driver)
      // The tail a new typing run may still coalesce into: unpushed, and not
      // in a push that has already picked it up.
      const open = unpushed.filter((event) => !frozen.has(event.id))
      const held = new Set(open.map((event) => event.id))
      const coalesced = coalesceTyping([...open, ...events])
      const kept = new Set(coalesced.map((event) => event.id))
      const statements: SqlStatement[] = []
      for (const event of open) {
        // tenant-exempt: the local store is one user per browser profile; and
        // this is the queue coalescing, not a delete of anything that happened.
        if (!kept.has(event.id))
          statements.push({ sql: "DELETE FROM events WHERE id = ?", params: [event.id] })
      }
      let position = await nextPosition(driver)
      const appended: RuminateEvent[] = []
      for (const event of coalesced) {
        if (held.has(event.id)) continue
        statements.push(insertEventStatement(event, (position += 1)))
        appended.push(event)
      }
      // Events a run coalesced away never reached the rows either — the one
      // that replaced them carries their final text — so the rows take the
      // net of what is appended, exactly as the replica's will.
      statements.push(...projectionStatements(netChanges(appended)))
      if (statements.length > 0) await driver.batch(statements)
    },

    unpushedEvents: () => loadUnpushed(driver),

    markEventsPushed: async (seqs) => {
      if (seqs.length === 0) return
      const statements: SqlStatement[] = []
      for (const [id, seq] of seqs) {
        statements.push({ sql: "UPDATE events SET seq = ? WHERE id = ?", params: [seq, id] })
      }
      // A row's `seq` is its last event's: stamp the rows these events changed,
      // never backwards.
      for (const [id, seq] of seqs) {
        for (const table of ["nodes", "link", "views"] as const) {
          statements.push({
            sql:
              `UPDATE ${table} SET seq = ?1 WHERE (seq IS NULL OR seq < ?1) AND ` +
              (table === "link"
                ? "source_id || '|' || destination_id || '|' || kind = "
                : "id = ") +
              `(SELECT entity_id FROM events WHERE id = ?2 AND entity = '${ENTITY_OF[table]}')`,
            params: [seq, id],
          })
        }
      }
      await driver.batch(statements)
    },

    applyPulledEvents: async (events) => {
      if (events.length === 0) return
      await driver.batch(events.map(insertPulledEventStatement))
    },

    eventLog: () => loadLog(driver),

    getAllRows: () => loadAllRows(driver),

    applyPull: async (plan) => {
      const statements: SqlStatement[] = []
      for (const [source, destination, kind] of plan.deleteLinks) {
        // tenant-exempt: a row absent from the replica's key lists no longer
        // exists there at all (purged, or never replicated) — there is no
        // tombstone to mirror, so the local copy goes too.
        statements.push({
          sql: "DELETE FROM link WHERE source_id = ? AND destination_id = ? AND kind = ?",
          params: [source, destination, kind],
        })
      }
      for (const id of plan.deleteNodes) {
        // tenant-exempt: as above — mirroring a purge, not performing a delete.
        statements.push({
          sql: "DELETE FROM link WHERE source_id = ? OR destination_id = ?",
          params: [id, id],
        })
        // tenant-exempt: as above.
        statements.push({ sql: "DELETE FROM nodes WHERE id = ?", params: [id] })
      }
      for (const node of plan.nodes) statements.push(upsertNodeStatement(node))
      for (const link of plan.links) statements.push(upsertLinkStatement(link))
      for (const view of plan.views) statements.push(upsertViewStatement(view))
      if (statements.length > 0) await driver.batch(statements)
    },

    getViews: () => loadViews(driver),

    clear: async () => {
      await driver.batch([
        // tenant-exempt: a cache reset discards the local database wholesale —
        // a wipe, not a delete, and tombstones would only resurrect the rows
        // the next pull replaces.
        { sql: "DELETE FROM link" },
        // tenant-exempt: as above.
        { sql: "DELETE FROM nodes" },
        // tenant-exempt: as above.
        { sql: "DELETE FROM views" },
        // tenant-exempt: as above — the device's log of a corpus it no longer
        // holds, unpushed events included (see `NoteStore.clear`).
        { sql: "DELETE FROM events" },
      ])
    },

    getMeta: async (key) => {
      const rows = await driver.exec("SELECT value FROM meta WHERE key = ?", [key])
      return rows.length > 0 && rows[0].value != null ? String(rows[0].value) : null
    },

    setMeta: async (key, value) => {
      await driver.batch([
        {
          sql:
            "INSERT INTO meta (key, value) VALUES (?, ?) " +
            "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          params: [key, value],
        },
      ])
    },

    close: () => driver.close(),
  }
}

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

/** The LIVE graph — what the snapshot is built from. `seq` rides along: it is
 * what an edit of the row says it believed it was changing (`base_seq`). */
async function loadMemGraph(driver: SqlDriver): Promise<{ nodes: NodeRow[]; links: LinkRow[] }> {
  const [nodeRows, linkRows] = await Promise.all([
    driver.exec(
      "SELECT id, type, text, props, updated_at, notes_id, seq FROM nodes WHERE deleted_at IS NULL",
    ),
    driver.exec(
      "SELECT source_id, destination_id, kind, sort_key, updated_at, seq FROM link " +
        "WHERE deleted_at IS NULL",
    ),
  ])
  return { nodes: nodeRows.map(toNodeRow), links: linkRows.map(toLinkRow) }
}

/** Every row, tombstones included — what replication has to carry. */
async function loadAllRows(
  driver: SqlDriver,
): Promise<{ nodes: NodeRow[]; links: LinkRow[]; views: ViewRow[] }> {
  const [nodeRows, linkRows, viewRows] = await Promise.all([
    driver.exec(
      "SELECT id, type, text, props, updated_at, deleted_at, notes_id, seq FROM nodes " +
        "/* includes-deleted: the full-push source; a delete only reaches other " +
        "devices if its tombstone travels */",
    ),
    driver.exec(
      "SELECT source_id, destination_id, kind, sort_key, updated_at, deleted_at, seq FROM link " +
        "/* includes-deleted: as above */",
    ),
    driver.exec(
      "SELECT id, root_id, filter, sort, pinned, sort_key, updated_at, deleted_at, seq FROM views " +
        "/* includes-deleted: as above */",
    ),
  ])
  return {
    nodes: nodeRows.map(toNodeRow),
    links: linkRows.map(toLinkRow),
    views: viewRows.map(toViewRow),
  }
}

/** Every LIVE view row — the entrypoints the sidebar and the note page read
 * (migrations/0015). Tombstones are for replication, not for reading. */
async function loadViews(driver: SqlDriver): Promise<ViewRow[]> {
  const rows = await driver.exec(
    "SELECT id, root_id, filter, sort, pinned, sort_key, updated_at, seq FROM views " +
      "WHERE deleted_at IS NULL",
  )
  return rows.map(toViewRow)
}

// -----------------------------------------------------------------------------
// The device's log
// -----------------------------------------------------------------------------

const ENTITY_OF = { nodes: "block", link: "link", views: "view" } as const

/** The queue: events the replica has not acknowledged, in the order made. */
async function loadUnpushed(driver: SqlDriver): Promise<RuminateEvent[]> {
  const rows = await driver.exec(
    "SELECT id, entity, entity_id, action, patch, v, batch, device, cause, base_seq, ref_seq, " +
      "at, tz FROM events WHERE seq IS NULL ORDER BY position",
  )
  return rows.map(toEvent)
}

/** The whole log, placed events first in `seq` order, then this device's
 * unpushed ones in the order made, each given a provisional `seq` above the
 * last placed one so a fold keeps them last. */
async function loadLog(driver: SqlDriver): Promise<LoggedEvent[]> {
  const rows = await driver.exec(
    "SELECT id, seq, entity, entity_id, action, patch, v, batch, device, cause, base_seq, " +
      "ref_seq, at, tz, origin, actor, received_at FROM events " +
      "ORDER BY seq IS NULL, seq, position",
  )
  let last = 0
  return rows.map((row) => {
    const event = toEvent(row) as LoggedEvent
    if (row.seq !== null) {
      event.seq = Number(row.seq)
      last = event.seq
    } else {
      event.seq = last += 1
      event.pending = true
    }
    if (row.origin !== null) event.origin = String(row.origin)
    if (row.actor !== null) event.actor = Number(row.actor)
    if (row.received_at !== null) event.received_at = Number(row.received_at)
    return event
  })
}

async function nextPosition(driver: SqlDriver): Promise<number> {
  const [row] = await driver.exec("SELECT COALESCE(MAX(position), 0) AS position FROM events")
  return Number(row?.position ?? 0)
}

const toEvent = (row: Record<string, SqlValue>): RuminateEvent =>
  ({
    id: row.id,
    entity: row.entity,
    entity_id: row.entity_id,
    action: row.action,
    patch: JSON.parse(String(row.patch)),
    v: Number(row.v),
    batch: row.batch,
    device: row.device,
    ...(row.cause === null ? {} : { cause: row.cause }),
    base_seq: row.base_seq === null ? null : Number(row.base_seq),
    ...(row.ref_seq === null ? {} : { ref_seq: Number(row.ref_seq) }),
    at: Number(row.at),
    tz: row.tz === null ? null : Number(row.tz),
  }) as RuminateEvent

/** A pulled event, placed: its `seq` is its position. One of this device's
 * own that the replica took but never answered is placed by this. */
const insertPulledEventStatement = (event: LoggedEvent): SqlStatement => ({
  sql:
    "INSERT INTO events (id, seq, entity, entity_id, action, patch, v, batch, device, cause, " +
    "base_seq, ref_seq, at, tz, origin, actor, received_at, position) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, origin = excluded.origin, " +
    "actor = excluded.actor, received_at = excluded.received_at",
  params: [
    event.id,
    event.seq,
    event.entity,
    event.entity_id,
    event.action,
    JSON.stringify(event.patch),
    event.v,
    event.batch,
    event.device,
    event.cause ?? null,
    event.base_seq ?? null,
    event.ref_seq ?? null,
    event.at,
    event.tz ?? null,
    event.origin ?? null,
    event.actor ?? null,
    event.received_at ?? null,
    event.seq,
  ],
})

const insertEventStatement = (event: RuminateEvent, position: number): SqlStatement => ({
  sql:
    "INSERT INTO events (id, seq, entity, entity_id, action, patch, v, batch, device, cause, " +
    "base_seq, ref_seq, at, tz, position) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  params: [
    event.id,
    event.entity,
    event.entity_id,
    event.action,
    JSON.stringify(event.patch),
    event.v,
    event.batch,
    event.device,
    event.cause ?? null,
    event.base_seq ?? null,
    event.ref_seq ?? null,
    event.at,
    event.tz ?? null,
    position,
  ],
})

// -----------------------------------------------------------------------------
// The projection: events → rows, as the replica does it
// -----------------------------------------------------------------------------

/** The columns a net change may set, per table — the fields of the entity.
 * A key outside this list never reaches SQL. */
const COLUMNS = {
  nodes: ["type", "text", "props", "notes_id"],
  link: ["sort_key"],
  views: ["root_id", "filter", "sort", "pinned", "sort_key"],
} as const

type Table = keyof typeof COLUMNS

const tableOf = (change: NetChange): Table =>
  change.entity === "block" ? "nodes" : change.entity === "link" ? "link" : "views"

const toSql = (value: unknown): SqlValue =>
  value === undefined || value === null
    ? null
    : typeof value === "boolean"
      ? value
        ? 1
        : 0
      : (value as SqlValue)

/** The tombstone a change leaves: stamped, cleared, or (null) as it was. */
const tombstoneOf = (change: NetChange): SqlValue | undefined =>
  change.deleted === null ? undefined : change.deleted ? (change.deleted_at ?? change.at) : null

/**
 * The statements that lay a batch's net changes onto the rows: one per
 * entity, the same two shapes the replica's projection has — an INSERT that
 * revives or overwrites for a change that creates, an UPDATE of the named
 * fields for one that does not. Patches are absolute, so the net of a run is
 * the last value of each field (`netChanges`) and the order within the batch
 * no longer matters.
 */
function projectionStatements(changes: readonly NetChange[]): SqlStatement[] {
  const statements: SqlStatement[] = []
  for (const change of changes) {
    const table = tableOf(change)
    const key = keyOf(change)
    const tombstone = tombstoneOf(change)
    if (change.created !== null) {
      const columns = COLUMNS[table].filter((column) => column in change.created!)
      const names = [...key.columns, ...columns, "updated_at", "deleted_at"]
      const values: SqlValue[] = [
        ...key.values,
        ...columns.map((column) => toSql(change.created![column])),
        change.at,
        tombstone ?? null,
      ]
      // tenant-exempt: the local store is one user per browser profile
      // (src/data/corpus-schema.ts). A create over a row that is there — a
      // revived tombstone, a retry — lands as the fold lands it: every field.
      statements.push({
        sql:
          `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")}) ` +
          `ON CONFLICT (${key.columns.join(", ")}) DO UPDATE SET ` +
          [...columns, "updated_at", "deleted_at"]
            .map((column) => `${column} = excluded.${column}`)
            .join(", "),
        params: values,
      })
      continue
    }
    const columns = COLUMNS[table].filter((column) => column in change.set)
    const sets = [...columns.map((column) => `${column} = ?`), "updated_at = ?"]
    const params: SqlValue[] = [...columns.map((column) => toSql(change.set[column])), change.at]
    if (tombstone !== undefined) {
      sets.push("deleted_at = ?")
      params.push(tombstone)
    }
    // tenant-exempt: as above.
    statements.push({
      sql:
        `UPDATE ${table} SET ${sets.join(", ")} WHERE ` +
        key.columns.map((column) => `${column} = ?`).join(" AND "),
      params: [...params, ...key.values],
    })
  }
  return statements
}

/** A change's primary key, as columns and values. A link is addressed by its
 * entity id, `source|destination|kind` (`linkEntityId`). */
function keyOf(change: NetChange): { columns: string[]; values: SqlValue[] } {
  if (change.entity !== "link") return { columns: ["id"], values: [change.entity_id] }
  const [source, destination, kind] = change.entity_id.split("|")
  return { columns: ["source_id", "destination_id", "kind"], values: [source, destination, kind] }
}

// -----------------------------------------------------------------------------
// The pull: the replica's rows, verbatim
// -----------------------------------------------------------------------------

/** Upsert one view row, last-writer-wins, as the replica does. A delete is a
 * row carrying `deleted_at`, so it goes through here too. */
function upsertViewStatement(view: ViewRow): SqlStatement {
  return {
    // tenant-exempt: the local store is one user per browser profile; there is
    // no second tenant in an OPFS database (src/data/corpus-schema.ts).
    sql:
      "INSERT INTO views (id, root_id, filter, sort, pinned, sort_key, updated_at, deleted_at, seq) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT (id) DO UPDATE SET root_id = excluded.root_id, filter = excluded.filter, " +
      "sort = excluded.sort, pinned = excluded.pinned, sort_key = excluded.sort_key, " +
      "updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, seq = excluded.seq " +
      "WHERE excluded.updated_at >= views.updated_at",
    params: [
      view.id,
      view.root_id,
      view.filter,
      view.sort,
      view.pinned ? 1 : 0,
      view.sort_key,
      view.updated_at,
      view.deleted_at ?? null,
      view.seq ?? null,
    ],
  }
}

const upsertNodeStatement = (node: NodeRow): SqlStatement => ({
  sql:
    "INSERT INTO nodes (id, type, text, props, updated_at, deleted_at, notes_id, seq) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT (id) DO UPDATE SET type = excluded.type, text = excluded.text, " +
    "props = excluded.props, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, " +
    // A note id is set once and never cleared by a row that carries none.
    "notes_id = COALESCE(excluded.notes_id, nodes.notes_id), seq = excluded.seq",
  params: [
    node.id,
    node.type,
    node.text,
    node.props,
    node.updated_at,
    node.deleted_at ?? null,
    node.notes_id ?? null,
    node.seq ?? null,
  ],
})

const upsertLinkStatement = (link: LinkRow): SqlStatement => ({
  sql:
    "INSERT INTO link (source_id, destination_id, kind, sort_key, updated_at, deleted_at, seq) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT (source_id, destination_id, kind) DO UPDATE SET " +
    "sort_key = excluded.sort_key, updated_at = excluded.updated_at, " +
    "deleted_at = excluded.deleted_at, seq = excluded.seq",
  params: [
    link.source_id,
    link.destination_id,
    link.kind,
    link.sort_key,
    link.updated_at,
    link.deleted_at ?? null,
    link.seq ?? null,
  ],
})
