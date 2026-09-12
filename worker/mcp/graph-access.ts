// The corpus, as an MCP grant sees it: one snapshot in, scoped reads and
// planned writes out (docs/mcp-server.md).
//
// ## Why a whole snapshot
//
// Every read tool here answers a question the APP already answers from a
// `GraphSnapshot` in memory — what a note's markdown is (`rollup`), what it
// is called and tagged (`noteFromPage`), what a node's children are, which
// notes reach a block. So rather than re-implement each of those as SQL — a
// second, drifting definition of "what the user can see" — this module loads
// the tenant's live rows once per request and then calls the app's own pure
// functions. An agent traversing the graph sees what the person would see,
// because it is the same code.
//
// The cost of that fidelity is two queries and one corpus's worth of rows per
// tool call. That is the same read a replica full pull makes (measured at
// ~540 rows, `worker/d1-sql-driver.ts`), an order of magnitude under the
// audit threshold there, and it is bounded by the corpus rather than by how
// hard an agent pushes. If a corpus ever outgrows it, the fix is a
// note-scoped load — the seam is `loadSnapshot`, and nothing above it would
// change.
//
// ## The scope
//
// `visibleNodes` turns the grant's NOTE ids into the NODE ids an agent may
// see, and it is the only definition of that. A node is visible when it is a
// granted page, when it is reachable from one through live child links, or
// when it was written in one (`notes_id` — the Unassigned basket, which the
// person can see, so the agent can too). Derived from the grant and the
// graph; never from anything the agent sends.
//
// An unrestricted grant gets `null`, meaning "no filter", so the common case
// costs no traversal at all.
//
// Everything below takes a `ScopedGraph`, and the accessors are the only way
// a tool reads a node — so a tool cannot forget to apply the filter, because
// it never touches the snapshot directly.

import { serialize } from "../../src/blocks/serialize"
import { basketDoc, basketRootIds } from "../../src/data/basket"
import {
  PAGE_TYPE,
  buildGraphSnapshot,
  pageDoc,
  parseProps,
  rollup,
  type GraphSnapshot,
} from "../../src/data/graph"
import { noteFromPage } from "../../src/data/note-meta"
import { opsToRows } from "../../src/data/ops-rows"
import { pageIds, parentsIndex, reachableFrom, type Op } from "../../src/data/ops"
import type { Note } from "../../src/schema"
import { planReplicaPut, toLinkRow, toNodeRow } from "../handlers/replica-payload"
import type { TenantDb } from "../tenancy-db"
import type { Grant } from "./grant"

/**
 * The tenant's LIVE graph. Tombstones are dropped here rather than filtered
 * later: `buildGraphSnapshot` is the app's own read-time discard, and a
 * snapshot that never held a deleted row cannot leak one.
 */
export async function loadSnapshot(tenant: TenantDb): Promise<GraphSnapshot> {
  const [nodeRows, linkRows] = await Promise.all([
    tenant.exec(
      "SELECT id, type, text, props, updated_at, notes_id FROM nodes " +
        "WHERE user_id = :tenant AND deleted_at IS NULL",
    ),
    tenant.exec(
      "SELECT source_id, destination_id, kind, sort_key, updated_at FROM link " +
        "WHERE user_id = :tenant AND deleted_at IS NULL",
    ),
  ])
  return buildGraphSnapshot(nodeRows.map(toNodeRow), linkRows.map(toLinkRow))
}

/**
 * The node ids this grant may see, or `null` for "every node".
 *
 * Three sources, all derived (see the module header): the granted pages
 * themselves, everything reachable from them over live child links, and every
 * node written in one of them. A granted page id that names no live page
 * contributes nothing — a grant over a deleted note is a grant over nothing,
 * never a grant over everything.
 */
function visibleNodes(grant: Grant, snapshot: GraphSnapshot): Set<string> | null {
  if (grant.noteIds === null) return null

  const granted = new Set<string>()
  for (const id of grant.noteIds) {
    if (snapshot.nodes.get(id)?.type === PAGE_TYPE) granted.add(id)
  }

  // The seeds: the granted pages, and every block written in one. The second
  // group is the notes' Unassigned baskets — blocks nothing links to any more,
  // which the person still sees at the foot of the note.
  const seeds = [...granted]
  for (const node of snapshot.nodes.values()) {
    if (node.notes_id !== undefined && granted.has(node.notes_id)) seeds.push(node.id)
  }

  // One walk from all of them. Walking from the basket roots too is what makes
  // a scoped agent see what the PERSON sees: the basket shows an unreached
  // block with everything beneath it, so hiding those children would make the
  // agent's view of the note quietly different from the one on screen.
  const visible = new Set<string>(seeds)
  for (const id of reachableFrom(snapshot, seeds)) visible.add(id)
  return visible
}

/**
 * The grant's view of the corpus: the snapshot, the node filter derived from
 * it, and the two indexes the traversal tools would otherwise rebuild per
 * node. The indexes are lazy — a call that only reads one note never pays for
 * them — and memoized, so a call that reads many pays once.
 */
export interface ScopedGraph {
  readonly snapshot: GraphSnapshot
  /** null = unrestricted. */
  readonly visible: Set<string> | null
  /** Visible page ids, sorted. */
  pages(): string[]
  /** Node id → the visible pages that reach it (a page reaches itself). */
  noteIndex(): Map<string, string[]>
  /** Node id → its visible parents, sorted. */
  parentIndex(): Map<string, string[]>
}

function makeScopedGraph(snapshot: GraphSnapshot, visible: Set<string> | null): ScopedGraph {
  const sees = (id: string) => visible === null || visible.has(id)

  let pages: string[] | undefined
  let notes: Map<string, string[]> | undefined
  let parents: Map<string, string[]> | undefined

  const graph: ScopedGraph = {
    snapshot,
    visible,
    pages() {
      // Sorted by id so a paged list is repeatable — the spec asks list
      // results to come back in a deterministic order.
      if (!pages) pages = pageIds(snapshot).filter(sees).sort()
      return pages
    },
    noteIndex() {
      if (notes) return notes
      notes = new Map()
      const add = (nodeId: string, pageId: string) => {
        const list = notes as Map<string, string[]>
        const existing = list.get(nodeId)
        if (existing) existing.push(pageId)
        else list.set(nodeId, [pageId])
      }
      // One subtree walk per page: O(links) in total, not O(pages × nodes).
      for (const pageId of graph.pages()) {
        add(pageId, pageId)
        for (const reached of reachableFrom(snapshot, [pageId])) {
          if (sees(reached)) add(reached, pageId)
        }
      }
      return notes
    },
    parentIndex() {
      if (parents) return parents
      parents = new Map()
      for (const [id, sources] of parentsIndex(snapshot)) {
        if (!sees(id)) continue
        parents.set(id, [...sources].filter(sees).sort())
      }
      return parents
    },
  }
  return graph
}

export async function scopedGraph(tenant: TenantDb, grant: Grant): Promise<ScopedGraph> {
  const snapshot = await loadSnapshot(tenant)
  return makeScopedGraph(snapshot, visibleNodes(grant, snapshot))
}

// -----------------------------------------------------------------------------
// Reads — the only way a tool touches a node
// -----------------------------------------------------------------------------

/** Is this node inside the grant's view? */
export const sees = (graph: ScopedGraph, id: string): boolean =>
  graph.visible === null || graph.visible.has(id)

/** A visible node row, or null. */
export const nodeOf = (graph: ScopedGraph, id: string) =>
  sees(graph, id) ? (graph.snapshot.nodes.get(id) ?? null) : null

/** A visible PAGE node, or null — what every note-addressed tool starts with. */
export function pageOf(graph: ScopedGraph, id: string) {
  const row = nodeOf(graph, id)
  return row !== null && row.type === PAGE_TYPE ? row : null
}

/** A page's `Note` — title, tags, tasks, headings, preview text — exactly as
 * the app derives it. Null when the id is not a visible page. */
export function noteOf(graph: ScopedGraph, id: string): Note | null {
  return pageOf(graph, id) === null ? null : noteFromPage(id, graph.snapshot)
}

/**
 * A page's markdown: the canonical rollup, `id::` lines included.
 *
 * Those id lines are the reason a read → edit → `update_note` round trip
 * keeps block identity instead of replacing every block with a new one (and
 * dropping the originals into the note's Unassigned basket). The tool
 * descriptions say so, because it is the one thing an agent has to preserve.
 */
export function markdownOf(graph: ScopedGraph, id: string): string | null {
  return pageOf(graph, id) === null ? null : rollup(id, graph.snapshot)
}

/**
 * A page's **Unassigned basket**: the blocks written in it that no page
 * reaches any more, as the app shows them (`basketRootIds` / `basketDoc`,
 * src/data/basket.ts) — the roots in the order they appear, and the whole
 * basket as markdown with its `id::` lines.
 *
 * Reusing the app's own definition matters more here than anywhere else,
 * because "unassigned" is a subtle predicate: it is *no page reaches it*, not
 * *it has no parent* — two orphaned blocks holding each other both have a
 * parent and neither can be seen — and a loop with no root at all still has
 * to be shown. Restating any of that here would be a second definition to
 * get wrong.
 *
 * Reachability is computed over the WHOLE corpus, not the grant's slice: a
 * block some non-granted note still holds is not unassigned, and must not be
 * reported as though it were. The grant filters the answer, not the question.
 */
export function unassignedOf(
  graph: ScopedGraph,
  pageId: string,
): { roots: string[]; markdown: string } | null {
  if (pageOf(graph, pageId) === null) return null
  const roots = basketRootIds(pageId, graph.snapshot).filter((id) => sees(graph, id))
  return { roots, markdown: roots.length === 0 ? "" : serialize(basketDoc(pageId, graph.snapshot)) }
}

/** A node's ordered, visible children. */
export function childrenOf(graph: ScopedGraph, id: string): string[] {
  if (!sees(graph, id)) return []
  return (graph.snapshot.childLinks.get(id) ?? [])
    .map((link) => link.destination_id)
    .filter((child) => sees(graph, child) && graph.snapshot.nodes.has(child))
}

/** A node's visible parents — traversal upwards, and the backlink answer. */
export const parentsOf = (graph: ScopedGraph, id: string): string[] =>
  sees(graph, id) ? (graph.parentIndex().get(id) ?? []) : []

/** Which visible pages reach this node — "what notes is this block in?". */
export const notesReaching = (graph: ScopedGraph, id: string): string[] =>
  sees(graph, id) ? (graph.noteIndex().get(id) ?? []) : []

/** A node's props as an object, or null. */
export const propsOf = (graph: ScopedGraph, id: string): Record<string, unknown> | null => {
  const row = nodeOf(graph, id)
  return row ? parseProps(row.props) : null
}

/** The page's doc, for the write tools to edit. Null when not a visible page. */
export const docOf = (graph: ScopedGraph, id: string) =>
  pageOf(graph, id) === null ? null : pageDoc(id, graph.snapshot)

// -----------------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------------

/**
 * Persist a batch of ops.
 *
 * Everything a write tool does converges here, and it goes out through the
 * SAME planner the replica push does (`planReplicaPut`): per-row
 * last-writer-wins, one atomic batch, and a fresh server `seq` on every row.
 * That last part is what makes an agent's edit arrive in the browser — the
 * next `?since=` pull reads it like any other change, with no second sync
 * path to keep correct.
 *
 * No `cursor` is passed: `meta.replica_cursor` is the CLIENT's marker of what
 * it has pushed, and an agent writing through a different door must not move
 * it.
 */
export async function applyOpsToReplica(
  tenant: TenantDb,
  snapshot: GraphSnapshot,
  ops: readonly Op[],
  now: number = Date.now(),
): Promise<{ nodes: number; links: number }> {
  if (ops.length === 0) return { nodes: 0, links: 0 }
  const diff = opsToRows(snapshot, ops, now)
  const statements = planReplicaPut({ nodes: diff.nodes, links: diff.links }, now)
  if (statements.length > 0) await tenant.batch(statements)
  return { nodes: diff.nodes.length, links: diff.links.length }
}
