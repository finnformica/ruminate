import migration0001 from "../../migrations/0001_init.sql?raw"
import migration0002 from "../../migrations/0002_nodes.sql?raw"
import {
  emptyGraphDiff,
  type GraphDiff,
  type LinkKey,
  type LinkRow,
  type NodeRow,
} from "../../worker/handlers/replica-payload"
import type { NoteId } from "../schema"
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
 * schema v2 graph (docs/graph-schema-v2.md): `nodes` + `link` + `meta`.
 *
 * Backed by any `SqlDriver` (sqlite-wasm/OPFS in the browser, `node:sqlite`
 * in tests) and the exact migration files that initialize the D1 replica.
 * The graph is truth; markdown reads are the rollup. Writes ingest markdown
 * through `docToGraphParts` and land as row *diffs* — unchanged rows keep
 * their `updated_at` (and sort keys), which is what makes per-row LWW sync
 * meaningful.
 */
export interface SqlNoteStore extends NoteStore {
  /** Wipe the graph and repopulate from a full corpus, in one transaction. */
  replaceAll(notes: Record<NoteId, string>): Promise<void>
  /** Row counts, for the diagnostics panel. */
  counts(): Promise<{ pages: number; nodes: number; links: number }>
  /** Every row of both tables — the replica full-push source. */
  getAllRows(): Promise<{ nodes: NodeRow[]; links: LinkRow[] }>
  /** Apply a planned pull (row upserts + deletes) in one transaction. Rows
   * land verbatim — remote `updated_at` values are preserved. */
  applyPull(plan: GraphDiff): Promise<void>
  /** Read a `meta` key (e.g. the D1 pull cursor), or null when unset. */
  getMeta(key: string): Promise<string | null>
  /** Write a `meta` key. Kept in the same database as the rows it describes,
   * so wiping the store can never leave a stale cursor behind. */
  setMeta(key: string, value: string): Promise<void>
  close(): Promise<void>
}

const SCHEMA_VERSION = "2"

/** Drop everything either migration creates, so an incompatible schema can be
 * rebuilt from scratch — safe because the store can be re-pulled from D1. */
const RESET_SQL = `
DROP TABLE IF EXISTS link;
DROP TABLE IF EXISTS nodes;
DROP TABLE IF EXISTS links;
DROP TABLE IF EXISTS blocks;
DROP TABLE IF EXISTS view_state;
DROP TABLE IF EXISTS notes;
DROP TABLE IF EXISTS meta;
`

const MIGRATIONS = migration0001 + "\n" + migration0002

/**
 * Open a `NoteStore` on `driver`, applying the migrations when the database is
 * empty. A v1 database is migrated in place by `0002` (which drops the v1
 * tables — contents re-pull from D1); anything else unrecognized is reset.
 */
export async function openSqlNoteStore(driver: SqlDriver): Promise<SqlNoteStore> {
  const tables = await driver.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
  )
  if (tables.length === 0) {
    await driver.execScript(MIGRATIONS)
  } else {
    const rows = await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")
    const version = rows[0]?.value
    if (version === "1") {
      await driver.execScript(migration0002)
    } else if (version !== SCHEMA_VERSION) {
      await driver.execScript(RESET_SQL + MIGRATIONS)
    }
  }

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
        "SELECT source_id FROM link WHERE destination_id = ? AND kind = ? ORDER BY source_id",
        [id, CHILD_KIND],
      )
      return rows.map((row) => String(row.source_id))
    },

    downstream: async (id) => {
      const rows = await driver.exec(
        "SELECT destination_id FROM link WHERE source_id = ? AND kind = ? " +
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
        writer.deleteLink(sourceId, destinationId, CHILD_KIND)
        cascadeOrphans(writer, new Set([destinationId]), pageRoot)
      })
    },

    replaceAll: async (notes) => {
      const now = Date.now()
      const statements: SqlStatement[] = [{ sql: "DELETE FROM link" }, { sql: "DELETE FROM nodes" }]
      const nodeStatements: SqlStatement[] = []
      const linkStatements: SqlStatement[] = []
      for (const id of Object.keys(notes).sort()) {
        const { nodes: rows, links } = docToGraph(id, notes[id], now)
        for (const node of rows) nodeStatements.push(upsertNodeStatement(node))
        for (const link of links) linkStatements.push(upsertLinkStatement(link))
      }
      await driver.batch([...statements, ...nodeStatements, ...linkStatements])
    },

    getAllRows: async () => {
      const mem = await loadGraph()
      return { nodes: [...mem.nodes.values()], links: [...mem.links.values()] }
    },

    applyPull: async (plan) => {
      const statements: SqlStatement[] = []
      for (const [source, destination, kind] of plan.deleteLinks) {
        statements.push({
          sql: "DELETE FROM link WHERE source_id = ? AND destination_id = ? AND kind = ?",
          params: [source, destination, kind],
        })
      }
      for (const id of plan.deleteNodes) {
        statements.push({
          sql: "DELETE FROM link WHERE source_id = ? OR destination_id = ?",
          params: [id, id],
        })
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
        "SELECT (SELECT COUNT(*) FROM nodes WHERE type = 'page') AS pages, " +
          "(SELECT COUNT(*) FROM nodes) AS nodes, " +
          "(SELECT COUNT(*) FROM link) AS links",
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
  /** All link rows keyed by `${source}\x1f${dest}\x1f${kind}`. */
  links: Map<string, LinkRow>
}

const linkMapKey = (source: string, destination: string, kind: string) =>
  `${source}\x1f${destination}\x1f${kind}`

async function loadMemGraph(driver: SqlDriver): Promise<MemGraph> {
  const [nodeRows, linkRows] = await Promise.all([
    driver.exec("SELECT id, type, text, props, updated_at FROM nodes"),
    driver.exec("SELECT source_id, destination_id, kind, sort_key, updated_at FROM link"),
  ])
  const nodes = new Map<string, NodeRow>()
  for (const row of nodeRows) {
    nodes.set(String(row.id), {
      id: String(row.id),
      type: String(row.type),
      text: String(row.text),
      props: row.props === null ? null : String(row.props),
      updated_at: Number(row.updated_at),
    })
  }
  const links = new Map<string, LinkRow>()
  for (const row of linkRows) {
    const link: LinkRow = {
      source_id: String(row.source_id),
      destination_id: String(row.destination_id),
      kind: String(row.kind),
      sort_key: String(row.sort_key),
      updated_at: Number(row.updated_at),
    }
    links.set(linkMapKey(link.source_id, link.destination_id, link.kind), link)
  }
  return { nodes, links }
}

const hasLink = (mem: MemGraph, source: string, destination: string) =>
  mem.links.has(linkMapKey(source, destination, CHILD_KIND))

/** A node's child links, in sibling order (sort key, destination tiebreak). */
function childLinksOf(mem: MemGraph, id: string): LinkRow[] {
  const out: LinkRow[] = []
  for (const link of mem.links.values()) {
    if (link.kind === CHILD_KIND && link.source_id === id) out.push(link)
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

/** Sources of the child links pointing at `id`. */
function parentIdsOf(mem: MemGraph, id: string): string[] {
  const out: string[] = []
  for (const link of mem.links.values()) {
    if (link.kind === CHILD_KIND && link.destination_id === id) out.push(link.source_id)
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
 * Accumulates row changes for one transaction: mutates the in-memory graph
 * immediately (so later planning in the same batch sees earlier changes) and
 * records the final row state per key. Upserts and deletes cancel each other,
 * so the emitted diff is exactly the net change.
 */
interface GraphWriter {
  mem: MemGraph
  now: number
  nodeUpserts: Map<string, NodeRow>
  nodeDeletes: Set<string>
  linkUpserts: Map<string, LinkRow>
  linkDeletes: Map<string, LinkKey>
  upsertNode(node: NodeRow): void
  deleteNode(id: string): void
  upsertLink(link: LinkRow): void
  deleteLink(source: string, destination: string, kind: string): void
}

function createGraphWriter(mem: MemGraph): GraphWriter {
  const writer: GraphWriter = {
    mem,
    now: Date.now(),
    nodeUpserts: new Map(),
    nodeDeletes: new Set(),
    linkUpserts: new Map(),
    linkDeletes: new Map(),
    upsertNode(node) {
      mem.nodes.set(node.id, node)
      writer.nodeDeletes.delete(node.id)
      writer.nodeUpserts.set(node.id, node)
    },
    deleteNode(id) {
      // Delete every link touching the node explicitly (recorded per row) so
      // nothing depends on the engine enforcing ON DELETE CASCADE.
      for (const link of [...mem.links.values()]) {
        if (link.source_id === id || link.destination_id === id) {
          writer.deleteLink(link.source_id, link.destination_id, link.kind)
        }
      }
      mem.nodes.delete(id)
      writer.nodeUpserts.delete(id)
      writer.nodeDeletes.add(id)
    },
    upsertLink(link) {
      const key = linkMapKey(link.source_id, link.destination_id, link.kind)
      mem.links.set(key, link)
      writer.linkDeletes.delete(key)
      writer.linkUpserts.set(key, link)
    },
    deleteLink(source, destination, kind) {
      const key = linkMapKey(source, destination, kind)
      mem.links.delete(key)
      writer.linkUpserts.delete(key)
      writer.linkDeletes.set(key, [source, destination, kind])
    },
  }
  return writer
}

const upsertNodeStatement = (node: NodeRow): SqlStatement => ({
  sql:
    "INSERT INTO nodes (id, type, text, props, updated_at) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT (id) DO UPDATE SET type = excluded.type, text = excluded.text, " +
    "props = excluded.props, updated_at = excluded.updated_at",
  params: [node.id, node.type, node.text, node.props, node.updated_at],
})

const upsertLinkStatement = (link: LinkRow): SqlStatement => ({
  sql:
    "INSERT INTO link (source_id, destination_id, kind, sort_key, updated_at) " +
    "VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT (source_id, destination_id, kind) DO UPDATE SET " +
    "sort_key = excluded.sort_key, updated_at = excluded.updated_at",
  params: [link.source_id, link.destination_id, link.kind, link.sort_key, link.updated_at],
})

/** Turn the writer's net change into SQL (deletes first, nodes before links)
 * and the `GraphDiff` handed to the replica queue. */
function emitWrite(writer: GraphWriter): { statements: SqlStatement[]; diff: GraphDiff } {
  const statements: SqlStatement[] = []
  for (const [source, destination, kind] of writer.linkDeletes.values()) {
    statements.push({
      sql: "DELETE FROM link WHERE source_id = ? AND destination_id = ? AND kind = ?",
      params: [source, destination, kind],
    })
  }
  for (const id of writer.nodeDeletes) {
    statements.push({ sql: "DELETE FROM nodes WHERE id = ?", params: [id] })
  }
  for (const node of writer.nodeUpserts.values()) statements.push(upsertNodeStatement(node))
  for (const link of writer.linkUpserts.values()) statements.push(upsertLinkStatement(link))

  const diff: GraphDiff = {
    ...emptyGraphDiff(),
    nodes: [...writer.nodeUpserts.values()],
    links: [...writer.linkUpserts.values()],
    deleteNodes: [...writer.nodeDeletes],
    deleteLinks: [...writer.linkDeletes.values()],
  }
  return { statements, diff }
}

/**
 * Ingest one note as a diff against the current graph: nodes whose
 * type/text/props changed are upserted (fresh `updated_at`), sibling orders
 * are reconciled so unchanged links keep their sort keys, nodes that fell out
 * of the note and have no other parent are deleted, and children orphaned by
 * those deletions are rescued to the page root.
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
        writer.deleteLink(parentId, link.destination_id, CHILD_KIND)
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

/** Delete a page: the page node goes, and every node that is thereby left
 * without any inbound link cascades away (multi-homed nodes survive). */
function planNoteDelete(writer: GraphWriter, noteId: NoteId) {
  const { mem } = writer
  if (!mem.nodes.has(noteId)) return
  const children = childLinksOf(mem, noteId).map((link) => link.destination_id)
  writer.deleteNode(noteId)
  cascadeOrphans(writer, new Set(children), null)
}

/**
 * Delete-rescue (docs/graph-schema-v2.md): process `candidates` — nodes whose
 * last known occurrence may just have been unlinked. A candidate that still
 * has an inbound link lives on. Otherwise its row is deleted; each child left
 * with no inbound link is either itself a candidate (cascades) or, when
 * `rescueRootId` is a live page, re-parented there with trailing sort keys.
 * With no rescue target (page deletion) orphans cascade away entirely.
 */
function cascadeOrphans(writer: GraphWriter, candidates: Set<string>, rescueRootId: string | null) {
  const { mem, now } = writer
  const queue = [...candidates]
  while (queue.length > 0) {
    const id = queue.shift() as string
    if (!mem.nodes.has(id)) continue
    if (parentIdsOf(mem, id).length > 0) continue
    const childIds = childLinksOf(mem, id).map((link) => link.destination_id)
    writer.deleteNode(id)
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
