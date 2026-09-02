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
import type { NoteId } from "../schema"
import { ensureCorpusSchema } from "./corpus-schema"
import {
  CHILD_KIND,
  PAGE_TYPE,
  buildGraphSnapshot,
  docToGraph,
  docToGraphParts,
  reconcileSortKeys,
  rollup,
  sortKeyBetween,
} from "./graph"
import type { NoteStore } from "./note-store"
import type { SqlDriver, SqlStatement } from "./sql-driver"

/**
 * The SQL implementation of `NoteStore` — the store the app runs on, over the
 * schema v3 graph (docs/graph-schema-v2.md): `nodes` + `link` + `meta`.
 *
 * Backed by any `SqlDriver` (sqlite-wasm/OPFS in the browser, `node:sqlite` in
 * tests) and the exact migration files that initialize the D1 replica — in the
 * **single-tenant** shape (`corpus-schema.ts`): one user per browser profile,
 * so no `user_id` column, but the same `deleted_at` soft deletes the replica
 * has. The graph is truth; markdown reads are the rollup. Writes ingest
 * markdown through `docToGraphParts` and land as row *diffs* — unchanged rows
 * keep their `updated_at` (and sort keys), which is what makes per-row LWW
 * sync meaningful.
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
export interface SqlNoteStore extends NoteStore {
  /** Wipe the graph and repopulate from a full corpus, in one transaction. */
  replaceAll(notes: Record<NoteId, string>): Promise<void>
  /** LIVE row counts, for the diagnostics panel. */
  counts(): Promise<{ pages: number; nodes: number; links: number }>
  /** Every row of both tables, **tombstones included** — the replica
   * full-push source, and a delete only reaches other devices if it travels. */
  getAllRows(): Promise<{ nodes: NodeRow[]; links: LinkRow[] }>
  /** Apply a planned pull (row upserts + deletes) in one transaction. Rows
   * land verbatim — remote `updated_at` and `deleted_at` are preserved. */
  applyPull(plan: GraphDiff): Promise<void>
  /** Read a `meta` key (e.g. the D1 pull cursor), or null when unset. */
  getMeta(key: string): Promise<string | null>
  /** Write a `meta` key. Kept in the same database as the rows it describes,
   * so wiping the store can never leave a stale cursor behind. */
  setMeta(key: string, value: string): Promise<void>
  close(): Promise<void>
}

/**
 * Open a `NoteStore` on `driver`, applying the migrations when the database is
 * empty. A v1 database is migrated in place by `0002` (which drops the v1
 * tables — contents re-pull from the replica), a v2 one gains its soft-delete
 * columns, and anything else unrecognized is reset. The ladder itself lives in
 * `corpus-schema.ts`, shared with the D1 corpus.
 */
export async function openSqlNoteStore(driver: SqlDriver): Promise<SqlNoteStore> {
  await ensureCorpusSchema(driver, { init: migration0001, nodes: migration0002 }, "single")

  const loadGraph = () => loadMemGraph(driver)

  const runWrite = async (write: (writer: GraphWriter) => void): Promise<GraphDiff> => {
    const writer = createGraphWriter(await loadGraph())
    write(writer)
    const { statements, diff } = emitWrite(writer)
    if (statements.length > 0) await driver.batch(statements)
    return diff
  }

  return {
    getNote: async (id) => {
      const mem = await loadGraph()
      return rollup(id, buildGraphSnapshot([...mem.nodes.values()], [...mem.links.values()]))
    },

    getAllNotes: async () => {
      const mem = await loadGraph()
      const snapshot = buildGraphSnapshot([...mem.nodes.values()], [...mem.links.values()])
      const notes: Record<NoteId, string> = {}
      for (const node of mem.nodes.values()) {
        if (node.type !== PAGE_TYPE) continue
        const markdown = rollup(node.id, snapshot)
        if (markdown !== null) notes[node.id] = markdown
      }
      return notes
    },

    writeNotes: (updates) =>
      runWrite((writer) => {
        for (const [id, content] of Object.entries(updates)) {
          if (content === null) planNoteDelete(writer, id)
          else planNoteWrite(writer, id, content)
        }
      }),

    deleteNote: (id) => runWrite((writer) => planNoteDelete(writer, id)),

    upstream: async (id) => {
      const rows = await driver.exec(
        "SELECT source_id FROM link WHERE destination_id = ? AND kind = ? " +
          "AND deleted_at IS NULL " +
          "AND source_id IN (SELECT id FROM nodes WHERE deleted_at IS NULL) " +
          "AND destination_id IN (SELECT id FROM nodes WHERE deleted_at IS NULL) " +
          "ORDER BY source_id",
        [id, CHILD_KIND],
      )
      return rows.map((row) => String(row.source_id))
    },

    downstream: async (id) => {
      const rows = await driver.exec(
        "SELECT destination_id FROM link WHERE source_id = ? AND kind = ? " +
          "AND deleted_at IS NULL " +
          "AND source_id IN (SELECT id FROM nodes WHERE deleted_at IS NULL) " +
          "AND destination_id IN (SELECT id FROM nodes WHERE deleted_at IS NULL) " +
          "ORDER BY sort_key, destination_id",
        [id, CHILD_KIND],
      )
      return rows.map((row) => String(row.destination_id))
    },

    addLink: async (sourceId, destinationId, position) => {
      await runWrite((writer) => {
        const { mem } = writer
        if (!mem.nodes.has(sourceId)) throw new Error(`addLink: unknown source ${sourceId}`)
        if (!mem.nodes.has(destinationId)) {
          throw new Error(`addLink: unknown destination ${destinationId}`)
        }
        // Cycles are forbidden at write: reject when the source is reachable
        // from the destination (the new edge would close a loop).
        if (sourceId === destinationId || reaches(mem, destinationId, sourceId)) {
          throw new Error("addLink: link would create a cycle")
        }

        const siblings = childLinksOf(mem, sourceId).filter(
          (link) => link.destination_id !== destinationId,
        )
        let before: string | null = null
        let after: string | null = null
        if (position === undefined || position.after === undefined) {
          before = siblings.length > 0 ? siblings[siblings.length - 1].sort_key : null
        } else if (position.after === null) {
          after = siblings.length > 0 ? siblings[0].sort_key : null
        } else {
          const index = siblings.findIndex((link) => link.destination_id === position.after)
          if (index === -1) throw new Error(`addLink: unknown sibling ${position.after}`)
          before = siblings[index].sort_key
          after = index + 1 < siblings.length ? siblings[index + 1].sort_key : null
        }
        writer.upsertLink({
          source_id: sourceId,
          destination_id: destinationId,
          kind: CHILD_KIND,
          sort_key: sortKeyBetween(before, after),
          updated_at: writer.now,
        })
      })
    },

    removeLink: async (sourceId, destinationId) => {
      await runWrite((writer) => {
        const { mem } = writer
        if (!hasLink(mem, sourceId, destinationId)) return
        // Rescue target: the page root of the context the removal happens in.
        const pageRoot = findPageRoot(mem, sourceId)
        writer.tombstoneLink(sourceId, destinationId, CHILD_KIND)
        cascadeOrphans(writer, new Set([destinationId]), pageRoot)
      })
    },

    replaceAll: async (notes) => {
      const now = Date.now()
      const statements: SqlStatement[] = [
        // tenant-exempt: the repair path rebuilds the whole local corpus from
        // the files atom — a wipe, not a delete, and tombstones would only
        // resurrect the rows it is replacing.
        { sql: "DELETE FROM link" },
        // tenant-exempt: as above — replaceAll discards the local database.
        { sql: "DELETE FROM nodes" },
      ]
      const nodeStatements: SqlStatement[] = []
      const linkStatements: SqlStatement[] = []
      for (const id of Object.keys(notes).sort()) {
        const { nodes: rows, links } = docToGraph(id, notes[id], now)
        for (const node of rows) nodeStatements.push(upsertNodeStatement(node))
        for (const link of links) linkStatements.push(upsertLinkStatement(link))
      }
      await driver.batch([...statements, ...nodeStatements, ...linkStatements])
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

    counts: async () => {
      const rows = await driver.exec(
        // Read-time discard applies to counts too: a retained link into a
        // tombstoned node is not part of the graph anyone can see, so counting
        // it would make the local and remote figures disagree for no reason.
        "SELECT (SELECT COUNT(*) FROM nodes WHERE deleted_at IS NULL AND type = 'page') AS pages, " +
          "(SELECT COUNT(*) FROM nodes WHERE deleted_at IS NULL) AS nodes, " +
          "(SELECT COUNT(*) FROM link WHERE deleted_at IS NULL " +
          "AND source_id IN (SELECT id FROM nodes WHERE deleted_at IS NULL) " +
          "AND destination_id IN (SELECT id FROM nodes WHERE deleted_at IS NULL)) AS links",
      )
      return {
        pages: Number(rows[0]?.pages ?? 0),
        nodes: Number(rows[0]?.nodes ?? 0),
        links: Number(rows[0]?.links ?? 0),
      }
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
    driver.exec("SELECT id, type, text, props, updated_at FROM nodes WHERE deleted_at IS NULL"),
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
      "SELECT id, type, text, props, updated_at, deleted_at FROM nodes " +
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

const hasLink = (mem: MemGraph, source: string, destination: string) =>
  mem.links.has(linkMapKey(source, destination, CHILD_KIND))

/**
 * A node's child links, in sibling order (sort key, destination tiebreak).
 * Read-time discard: a link whose destination is no longer live is skipped —
 * retained in storage, absent from the walk.
 */
function childLinksOf(mem: MemGraph, id: string): LinkRow[] {
  const out: LinkRow[] = []
  for (const link of mem.links.values()) {
    if (link.kind !== CHILD_KIND || link.source_id !== id) continue
    if (!mem.nodes.has(link.destination_id)) continue
    out.push(link)
  }
  return out.sort((a, b) =>
    a.sort_key < b.sort_key
      ? -1
      : a.sort_key > b.sort_key
        ? 1
        : a.destination_id < b.destination_id
          ? -1
          : 1,
  )
}

/** Sources of the LIVE child links pointing at `id` (see `childLinksOf`). */
function parentIdsOf(mem: MemGraph, id: string): string[] {
  const out: string[] = []
  for (const link of mem.links.values()) {
    if (link.kind !== CHILD_KIND || link.destination_id !== id) continue
    if (!mem.nodes.has(link.source_id)) continue
    out.push(link.source_id)
  }
  return out
}

/** Is `target` reachable from `from` over child links? (Cycle check.) */
function reaches(mem: MemGraph, from: string, target: string): boolean {
  const seen = new Set<string>()
  const queue = [from]
  while (queue.length > 0) {
    const id = queue.pop() as string
    if (id === target) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const link of childLinksOf(mem, id)) queue.push(link.destination_id)
  }
  return false
}

/** Every node reachable from `rootId` (inclusive) over child links. */
function subtreeIds(mem: MemGraph, rootId: string): Set<string> {
  const seen = new Set<string>()
  if (!mem.nodes.has(rootId)) return seen
  const queue = [rootId]
  while (queue.length > 0) {
    const id = queue.pop() as string
    if (seen.has(id)) continue
    seen.add(id)
    for (const link of childLinksOf(mem, id)) queue.push(link.destination_id)
  }
  return seen
}

/** Nearest page node at or above `id` (breadth-first over inbound links). */
function findPageRoot(mem: MemGraph, id: string): string | null {
  const seen = new Set<string>()
  const queue = [id]
  while (queue.length > 0) {
    const current = queue.shift() as string
    if (seen.has(current)) continue
    seen.add(current)
    if (mem.nodes.get(current)?.type === PAGE_TYPE) return current
    queue.push(...parentIdsOf(mem, current))
  }
  return null
}

/**
 * Accumulates row changes for one transaction: mutates the in-memory (live)
 * graph immediately, so later planning in the same batch sees earlier changes,
 * and records the final row state per key. Every change — including a
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
    "INSERT INTO nodes (id, type, text, props, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT (id) DO UPDATE SET type = excluded.type, text = excluded.text, " +
    "props = excluded.props, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at",
  params: [node.id, node.type, node.text, node.props, node.updated_at, node.deleted_at ?? null],
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

/**
 * Ingest one note as a diff against the current graph: nodes whose
 * type/text/props changed are upserted (fresh `updated_at`), sibling orders
 * are reconciled so unchanged links keep their sort keys, nodes that fell out
 * of the note and have no other parent are tombstoned, and children orphaned
 * by those deletions are rescued to the page root.
 */
function planNoteWrite(writer: GraphWriter, noteId: NoteId, content: string) {
  const { mem, now } = writer
  // Every OTHER page's id is reserved: a block row claiming one (a stray
  // `id::` line from an external edit) must be re-minted, never allowed to
  // clobber that page's node row. Ingest also guards `noteId` itself.
  const reserved = new Set<string>()
  for (const node of mem.nodes.values()) {
    if (node.type === PAGE_TYPE && node.id !== noteId) reserved.add(node.id)
  }
  const { nodes, childrenOf } = docToGraphParts(noteId, content, now, reserved)

  // Cycle guard (belt-and-braces — reachable only through cross-note id
  // collisions): drop any desired edge that would close a loop, preferring
  // the never-lose-work outcome over rejecting the whole save.
  dropCycleCreatingEdges(mem, noteId, childrenOf)

  const oldSubtree = subtreeIds(mem, noteId)
  const newIds = new Set(nodes.map((node) => node.id))

  for (const node of nodes) {
    const old = mem.nodes.get(node.id)
    if (!old || old.type !== node.type || old.text !== node.text || old.props !== node.props) {
      writer.upsertNode(node)
    }
  }

  for (const [parentId, desired] of childrenOf) {
    const existingLinks = childLinksOf(mem, parentId)
    const keys = reconcileSortKeys(
      existingLinks.map((link) => ({ id: link.destination_id, sortKey: link.sort_key })),
      desired,
    )
    const desiredSet = new Set(desired)
    for (const link of existingLinks) {
      if (!desiredSet.has(link.destination_id)) {
        writer.tombstoneLink(parentId, link.destination_id, CHILD_KIND)
      }
    }
    for (const destinationId of desired) {
      const key = keys.get(destinationId) as string
      const existing = mem.links.get(linkMapKey(parentId, destinationId, CHILD_KIND))
      if (!existing || existing.sort_key !== key) {
        writer.upsertLink({
          source_id: parentId,
          destination_id: destinationId,
          kind: CHILD_KIND,
          sort_key: key,
          updated_at: now,
        })
      }
    }
  }

  const candidates = new Set([...oldSubtree].filter((id) => !newIds.has(id)))
  cascadeOrphans(writer, candidates, noteId)
}

/** Delete a page: the page node is tombstoned, and every node that is thereby
 * left without any inbound link cascades away (multi-homed nodes survive). */
function planNoteDelete(writer: GraphWriter, noteId: NoteId) {
  const { mem } = writer
  if (!mem.nodes.has(noteId)) return
  const children = childLinksOf(mem, noteId).map((link) => link.destination_id)
  writer.tombstoneNode(noteId)
  cascadeOrphans(writer, new Set(children), null)
}

/**
 * Delete-rescue (docs/graph-schema-v2.md), unchanged by soft deletes: process
 * `candidates` — nodes whose last known occurrence may just have been
 * unlinked. A candidate that still has a live inbound link lives on.
 * Otherwise its row is tombstoned; each child left with no live inbound link
 * is either itself a candidate (cascades) or, when `rescueRootId` is a live
 * page, re-parented there with trailing sort keys. With no rescue target
 * (page deletion) orphans cascade away entirely.
 */
function cascadeOrphans(writer: GraphWriter, candidates: Set<string>, rescueRootId: string | null) {
  const { mem, now } = writer
  const queue = [...candidates]
  while (queue.length > 0) {
    const id = queue.shift() as string
    if (!mem.nodes.has(id)) continue
    if (parentIdsOf(mem, id).length > 0) continue
    const childIds = childLinksOf(mem, id).map((link) => link.destination_id)
    writer.tombstoneNode(id)
    for (const childId of childIds) {
      if (!mem.nodes.has(childId) || parentIdsOf(mem, childId).length > 0) continue
      const rescue =
        rescueRootId !== null && !candidates.has(childId) && mem.nodes.has(rescueRootId)
      if (rescue) {
        const siblings = childLinksOf(mem, rescueRootId as string)
        writer.upsertLink({
          source_id: rescueRootId as string,
          destination_id: childId,
          kind: CHILD_KIND,
          sort_key: sortKeyBetween(
            siblings.length > 0 ? siblings[siblings.length - 1].sort_key : null,
            null,
          ),
          updated_at: now,
        })
      } else {
        queue.push(childId)
      }
    }
  }
}

/** Remove desired edges that would make the graph cyclic: DFS the prospective
 * graph from the page and cut any back-edge. */
function dropCycleCreatingEdges(mem: MemGraph, pageId: string, childrenOf: Map<string, string[]>) {
  const childrenFor = (id: string): string[] =>
    childrenOf.get(id) ?? childLinksOf(mem, id).map((link) => link.destination_id)

  const onPath = new Set<string>()
  const done = new Set<string>()
  const visit = (id: string) => {
    if (done.has(id)) return
    onPath.add(id)
    const children = childrenFor(id)
    const keep = children.filter((childId) => !onPath.has(childId))
    if (keep.length !== children.length && childrenOf.has(id)) childrenOf.set(id, keep)
    for (const childId of keep) visit(childId)
    onPath.delete(id)
    done.add(id)
  }
  visit(pageId)
}
