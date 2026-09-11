import migration0001 from "../../migrations/0001_init.sql?raw"
import migration0002 from "../../migrations/0002_nodes.sql?raw"
import {
  emptyGraphDiff,
  toLinkRow,
  toNodeRow,
  type GraphDiff,
  type LinkRow,
  type NodeRow,
} from "../../worker/handlers/replica-payload"
import { ensureCorpusSchema } from "./corpus-schema"
import { CHILD_KIND, buildGraphSnapshot } from "./graph"
import type { NoteStore } from "./note-store"
import type { Op } from "./ops"
import type { SqlDriver, SqlStatement } from "./sql-driver"

/**
 * The SQL implementation of `NoteStore` — the store the app runs on, over the
 * schema v3 graph (docs/graph-schema-v2.md): `nodes` + `link` + `meta`.
 *
 * Backed by any `SqlDriver` (sqlite-wasm/OPFS in the browser, `node:sqlite` in
 * tests) and the exact migration files that initialize the D1 replica — in the
 * **single-tenant** shape (`corpus-schema.ts`): one user per browser profile,
 * so no `user_id` column, but the same `deleted_at` soft deletes the replica
 * has. Ops land as row *diffs* — only the rows an op names are written, with
 * a fresh `updated_at` — which is what makes per-row LWW sync meaningful.
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
      return buildGraphSnapshot([...mem.nodes.values()], [...mem.links.values()])
    },

    applyOps: async (ops) => {
      const writer = createGraphWriter(await loadMemGraph(driver))
      for (const op of ops) planOp(writer, op)
      const { statements, diff } = emitWrite(writer)
      if (statements.length > 0) await driver.batch(statements)
      return diff
    },

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
      if (statements.length > 0) await driver.batch(statements)
    },

    clear: async () => {
      await driver.batch([
        // tenant-exempt: a cache reset discards the local database wholesale —
        // a wipe, not a delete, and tombstones would only resurrect the rows
        // the next pull replaces.
        { sql: "DELETE FROM link" },
        // tenant-exempt: as above.
        { sql: "DELETE FROM nodes" },
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
// In-memory working copy + write planning
// -----------------------------------------------------------------------------

interface MemGraph {
  nodes: Map<string, NodeRow>
  /** All LIVE link rows keyed by `${source}\x1f${dest}\x1f${kind}`. */
  links: Map<string, LinkRow>
}

const linkMapKey = (source: string, destination: string, kind: string) =>
  `${source}\x1f${destination}\x1f${kind}`

/** The LIVE graph — the working copy every read and write plans against. */
async function loadMemGraph(driver: SqlDriver): Promise<MemGraph> {
  const [nodeRows, linkRows] = await Promise.all([
    driver.exec(
      "SELECT id, type, text, props, updated_at, notes_id FROM nodes WHERE deleted_at IS NULL",
    ),
    driver.exec(
      "SELECT source_id, destination_id, kind, sort_key, updated_at FROM link " +
        "WHERE deleted_at IS NULL",
    ),
  ])
  const nodes = new Map<string, NodeRow>()
  for (const row of nodeRows) nodes.set(String(row.id), toNodeRow(row))
  const links = new Map<string, LinkRow>()
  for (const row of linkRows) {
    const link = toLinkRow(row)
    links.set(linkMapKey(link.source_id, link.destination_id, link.kind), link)
  }
  return { nodes, links }
}

/** Every row, tombstones included — what replication has to carry. */
async function loadAllRows(driver: SqlDriver): Promise<{ nodes: NodeRow[]; links: LinkRow[] }> {
  const [nodeRows, linkRows] = await Promise.all([
    driver.exec(
      "SELECT id, type, text, props, updated_at, deleted_at, notes_id FROM nodes " +
        "/* includes-deleted: the full-push source; a delete only reaches other " +
        "devices if its tombstone travels */",
    ),
    driver.exec(
      "SELECT source_id, destination_id, kind, sort_key, updated_at, deleted_at FROM link " +
        "/* includes-deleted: as above */",
    ),
  ])
  return { nodes: nodeRows.map(toNodeRow), links: linkRows.map(toLinkRow) }
}

/**
 * Accumulates row changes for one transaction: mutates the in-memory (live)
 * graph immediately, so later ops in the same batch see earlier changes, and
 * records the final row state per key. Every change — including a
 * tombstone — is an upsert of a whole row, so the emitted statements and the
 * emitted diff are the same thing said twice.
 *
 * `now` is captured once per writer: **all rows one write retires share one
 * `deleted_at`**, which is what makes "revive the rows stamped at T" a
 * well-defined restore.
 */
interface GraphWriter {
  mem: MemGraph
  now: number
  nodeWrites: Map<string, NodeRow>
  linkWrites: Map<string, LinkRow>
  upsertNode(node: NodeRow): void
  tombstoneNode(id: string): void
  upsertLink(link: LinkRow): void
  tombstoneLink(source: string, destination: string, kind: string): void
}

function createGraphWriter(mem: MemGraph): GraphWriter {
  const writer: GraphWriter = {
    mem,
    now: Date.now(),
    nodeWrites: new Map(),
    linkWrites: new Map(),
    upsertNode(node) {
      const live = { ...node }
      delete live.deleted_at
      mem.nodes.set(live.id, live)
      writer.nodeWrites.set(live.id, live)
    },
    tombstoneNode(id) {
      const node = mem.nodes.get(id)
      if (!node) return
      // Deliberately NOT cascading to link rows: a link pointing at a deleted
      // node is retained (it is where a restore would put the node back), and
      // the walk drops it at read time.
      mem.nodes.delete(id)
      writer.nodeWrites.set(id, { ...node, updated_at: writer.now, deleted_at: writer.now })
    },
    upsertLink(link) {
      const key = linkMapKey(link.source_id, link.destination_id, link.kind)
      const live = { ...link }
      delete live.deleted_at
      mem.links.set(key, live)
      writer.linkWrites.set(key, live)
    },
    tombstoneLink(source, destination, kind) {
      const key = linkMapKey(source, destination, kind)
      const link = mem.links.get(key)
      if (!link) return
      mem.links.delete(key)
      writer.linkWrites.set(key, { ...link, updated_at: writer.now, deleted_at: writer.now })
    },
  }
  return writer
}

const upsertNodeStatement = (node: NodeRow): SqlStatement => ({
  sql:
    "INSERT INTO nodes (id, type, text, props, updated_at, deleted_at, notes_id) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT (id) DO UPDATE SET type = excluded.type, text = excluded.text, " +
    "props = excluded.props, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, " +
    // A note id is set once and never cleared by a row that carries none.
    "notes_id = COALESCE(excluded.notes_id, nodes.notes_id)",
  params: [
    node.id,
    node.type,
    node.text,
    node.props,
    node.updated_at,
    node.deleted_at ?? null,
    node.notes_id ?? null,
  ],
})

const upsertLinkStatement = (link: LinkRow): SqlStatement => ({
  sql:
    "INSERT INTO link (source_id, destination_id, kind, sort_key, updated_at, deleted_at) " +
    "VALUES (?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT (source_id, destination_id, kind) DO UPDATE SET " +
    "sort_key = excluded.sort_key, updated_at = excluded.updated_at, " +
    "deleted_at = excluded.deleted_at",
  params: [
    link.source_id,
    link.destination_id,
    link.kind,
    link.sort_key,
    link.updated_at,
    link.deleted_at ?? null,
  ],
})

/** Turn the writer's net change into SQL (nodes before links) and the
 * `GraphDiff` handed to the replica queue. Tombstones ride in `nodes` /
 * `links` like any other row — that is what makes a delete replicate. */
function emitWrite(writer: GraphWriter): { statements: SqlStatement[]; diff: GraphDiff } {
  const nodes = [...writer.nodeWrites.values()]
  const links = [...writer.linkWrites.values()]
  const statements: SqlStatement[] = [
    ...nodes.map(upsertNodeStatement),
    ...links.map(upsertLinkStatement),
  ]
  return { statements, diff: { ...emptyGraphDiff(), nodes, links } }
}

/** One op as row writes. A `set*` on a node the store does not hold is
 * dropped (it was deleted underneath); everything else is verbatim. */
function planOp(writer: GraphWriter, op: Op) {
  const { mem, now } = writer
  switch (op.op) {
    case "create":
      writer.upsertNode({
        id: op.id,
        type: op.type,
        text: op.text,
        props: op.props,
        updated_at: now,
        ...(op.notesId ? { notes_id: op.notesId } : {}),
      })
      return
    case "setText":
    case "setType":
    case "setProps": {
      const node = mem.nodes.get(op.id)
      if (!node) return
      const next: NodeRow = { ...node, updated_at: now }
      if (op.op === "setText") next.text = op.text
      else if (op.op === "setType") next.type = op.type
      else next.props = op.props
      writer.upsertNode(next)
      return
    }
    case "link":
      writer.upsertLink({
        source_id: op.source,
        destination_id: op.destination,
        kind: CHILD_KIND,
        sort_key: op.sortKey,
        updated_at: now,
      })
      return
    case "unlink":
      writer.tombstoneLink(op.source, op.destination, CHILD_KIND)
      return
    case "delete":
      writer.tombstoneNode(op.id)
      return
  }
}
