// The corpus, as an MCP grant sees it: rows in, scoped reads and planned
// writes out (docs/mcp-server.md).
//
// ## One definition, two ways of feeding it
//
// Every read tool here answers a question the APP already answers from a
// `GraphSnapshot` in memory — what a note is called and tagged
// (`noteFromNode`), which of its blocks are unassigned (`basketRootIds`), what
// a node's children are, which notes reach a block (`reachableFrom`). Those
// pure functions are the only definition of "what the user can see" in this
// server; re-implementing any of them as SQL would be a second definition,
// free to drift from the one on screen, and that is the failure this feature
// cares most about avoiding.
//
// So nothing below re-implements them. What changed is only **which rows they
// are given**:
//
// - `scopedGraph` loads the tenant's whole live corpus — two queries, O(corpus)
//   rows. It is the reference implementation, it is what every write tool and
//   every corpus-wide read (`search`, `list_tags`) still uses, and the
//   equivalence tests run every targeted view against it.
// - the four **views** below load a bounded piece of the corpus instead, sized
//   to the question: a block's neighbourhood, a subtree to a depth, a block's
//   ancestry, a note. The same pure functions then run over that piece.
//
// ## Why a partial snapshot can be trusted
//
// Because each view is CLOSED under the questions its tool asks. The
// invariants, in the order they are relied on:
//
// 1. **Upward closure makes upward answers exact.** `linksAbove` returns every
//    child link ending at a node that reaches the seed. Every path from any
//    node down to the seed is therefore present, and no extra path to the seed
//    can exist outside it — so `parentsIndex` over those rows gives the seed's
//    true parents, and walking down from the note-typed nodes among them gives
//    exactly the notes that reach it. (It says nothing about any OTHER node in
//    the view, and nothing asks.)
// 2. **Downward closure to depth d + 1 makes a d-level outline exact.** A
//    block is emitted with its `childIds` and a `hasMoreChildren` flag, so the
//    walk needs the links leaving its deepest emitted level and the nodes at
//    the level past it — which is what `linksBelow(roots, d)` plus its endpoint
//    nodes is.
// 3. **The basket is exact when every candidate is either reached inside the
//    view or has its full ancestry inside it.** `basketRootIds` asks "which
//    blocks written in this note does no note reach?", which a partial view can
//    only get wrong in one direction: by calling a block unassigned when some
//    unloaded note reaches it. `noteView` loads the note's whole subtree (so
//    every candidate the note itself reaches is visibly reached) and the upward
//    closure of the candidates it does not (so every other note that reaches
//    one is visibly there).
//
// A view that loads too few rows makes an answer wrong, and the differential
// tests in `graph-load.test.ts` catch it by running the same call both ways. A
// view that loads too many only costs. There is no third outcome.
//
// ## The scope
//
// `visibleNodes` turns the grant's NOTE ids into the NODE ids an agent may
// see, and it is the only definition of that. A node is visible when it is a
// granted note, when it is reachable from one through live child links, or
// when it was written in one (`notes_id` — the Unassigned basket, which the
// person can see, so the agent can too). Derived from the grant and the
// graph; never from anything the agent sends.
//
// It too is computed twice from one definition: in memory over a loaded
// snapshot, and — for the targeted views, which never load the corpus — by a
// walk seeded at the granted notes (`scopeNodeIds`, graph-load.ts). The two
// are tested to agree.
//
// An unrestricted grant gets `null`, meaning "no filter", so the common case
// costs no traversal at all.
//
// Everything below takes a `ScopedGraph`, and the accessors are the only way
// a tool reads a node — so a tool cannot forget to apply the filter, because
// it never touches the snapshot directly.

import { basketRootIds } from "../../src/data/basket"
import { NOTE_TYPE, buildGraphSnapshot, parseProps, type GraphSnapshot } from "../../src/data/graph"
import { noteFromNode } from "../../src/data/note-meta"
import { opsToRows } from "../../src/data/ops-rows"
import { noteIds, parentsIndex, reachableFrom, type Op } from "../../src/data/ops"
import type { Note } from "../../src/schema"
import {
  planReplicaPut,
  toLinkRow,
  toNodeRow,
  type LinkRow,
  type NodeRow,
} from "../handlers/replica-payload"
import type { TenantDb } from "../tenancy-db"
import {
  linksAbove,
  linksBelow,
  linksFrom,
  noteNodes,
  nodesByIds,
  nodesWrittenIn,
  scopeNodeIds,
  type Fragment,
} from "./graph-load"
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
 * Three sources, all derived (see the module header): the granted notes
 * themselves, everything reachable from them over live child links, and every
 * node written in one of them. A granted note id that names no live page
 * contributes nothing — a grant over a deleted note is a grant over nothing,
 * never a grant over everything.
 */
function visibleNodes(grant: Grant, snapshot: GraphSnapshot): Set<string> | null {
  if (grant.noteIds === null) return null

  const granted = new Set<string>()
  for (const id of grant.noteIds) {
    if (snapshot.nodes.get(id)?.type === NOTE_TYPE) granted.add(id)
  }

  // The seeds: the granted notes, and every block written in one. The second
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
  /** Visible note ids, sorted. */
  notes(): string[]
  /** Node id → the visible notes that reach it (a note reaches itself). */
  noteIndex(): Map<string, string[]>
  /** Node id → its visible parents, sorted. */
  parentIndex(): Map<string, string[]>
}

function makeScopedGraph(snapshot: GraphSnapshot, visible: Set<string> | null): ScopedGraph {
  const sees = (id: string) => visible === null || visible.has(id)

  let noteList: string[] | undefined
  let noteIndex: Map<string, string[]> | undefined
  let parents: Map<string, string[]> | undefined

  const graph: ScopedGraph = {
    snapshot,
    visible,
    notes() {
      // Sorted by id so a paged list is repeatable — the spec asks list
      // results to come back in a deterministic order.
      if (!noteList) noteList = noteIds(snapshot).filter(sees).sort()
      return noteList
    },
    noteIndex() {
      if (noteIndex) return noteIndex
      const index = (noteIndex = new Map<string, string[]>())
      const add = (nodeId: string, noteId: string) => {
        const existing = index.get(nodeId)
        if (existing) existing.push(noteId)
        else index.set(nodeId, [noteId])
      }
      // One subtree walk per note: O(links) in total, not O(notes × nodes).
      for (const noteId of graph.notes()) {
        add(noteId, noteId)
        for (const reached of reachableFrom(snapshot, [noteId])) {
          if (sees(reached)) add(reached, noteId)
        }
      }
      return index
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
// The targeted views
// -----------------------------------------------------------------------------
//
// Each builds a `ScopedGraph` over a bounded slice of the corpus instead of
// all of it. What makes each one sound is stated at the top of this file; what
// each one loads is stated here. The pure functions that read them are the
// same ones the whole-corpus path uses, unchanged.

/**
 * Rows on their way to a snapshot.
 *
 * Links are keyed, because a view composes several reads and the same link can
 * come back from more than one: `buildGraphSnapshot` does not de-duplicate, so
 * a link kept twice would put a child in `childIds` twice.
 */
class Rows {
  private readonly nodes = new Map<string, NodeRow>()
  private readonly links = new Map<string, LinkRow>()

  addNodes(rows: readonly NodeRow[]): this {
    for (const row of rows) this.nodes.set(row.id, row)
    return this
  }

  /** A loader's result: its links, and whichever endpoints came with them. */
  add(fragment: Fragment): this {
    this.addNodes(fragment.nodes)
    for (const row of fragment.links) {
      this.links.set(`${row.source_id} ${row.destination_id} ${row.kind}`, row)
    }
    return this
  }

  /** Fill in any node row a loaded link names that has not arrived, plus
   * `also` — a view's seed, which no link need mention. */
  async complete(tenant: TenantDb, ...also: string[]): Promise<GraphSnapshot> {
    const wanted = new Set<string>(also)
    for (const link of this.links.values()) {
      wanted.add(link.source_id)
      wanted.add(link.destination_id)
    }
    for (const id of this.nodes.keys()) wanted.delete(id)
    if (wanted.size > 0) this.addNodes(await nodesByIds(tenant, [...wanted]))
    return buildGraphSnapshot([...this.nodes.values()], [...this.links.values()])
  }
}

/**
 * The grant's node filter for a view that has NOT loaded the corpus — the same
 * set `visibleNodes` derives, walked out of the rows instead
 * (`scopeNodeIds`, graph-load.ts).
 */
async function visibleFor(tenant: TenantDb, grant: Grant): Promise<Set<string> | null> {
  if (grant.noteIds === null) return null
  return new Set(await scopeNodeIds(tenant, [...grant.noteIds]))
}

/**
 * The note rows, plus the blocks of the notes a caller picks out of them —
 * what `list_notes` reads.
 *
 * Two phases, because a note list is two different questions. WHICH notes are
 * on the page, and in what order, is decided by facts on the note's own row
 * (its `updated_at` prop, and its id, which says whether it is a daily or a
 * weekly). WHAT each of those notes is — its tags, its task counts, its
 * preview — comes from its blocks. So the note rows are read first and `pick`
 * is asked which of them the answer names; only those notes' blocks follow.
 *
 * `pick` is the tool's own paging function (`notePage`, tools.ts), not a copy
 * of it, and it runs again on the finished view. Both runs see the same note
 * rows, so they cannot land on different pages.
 */
export async function notesView(
  tenant: TenantDb,
  grant: Grant,
  pick: (notes: ScopedGraph) => string[],
): Promise<ScopedGraph> {
  const visible = await visibleFor(tenant, grant)
  const heads = await noteNodes(tenant)
  const headsOnly = () => makeScopedGraph(buildGraphSnapshot(heads, []), visible)
  const wanted = pick(headsOnly())
  if (wanted.length === 0) return headsOnly()

  const rows = new Rows().addNodes(heads)
  rows.add(await linksBelow(tenant, wanted, null))
  return makeScopedGraph(await rows.complete(tenant), visible)
}

/**
 * One block, its children and its ancestry — what `get_block` reads: the row
 * itself, `childIds`, `parentIds`, and the notes it appears in.
 *
 * The upward closure answers the last two exactly (invariant 1); one hop down
 * answers `childIds`. Nothing here is O(corpus), and for a block in an
 * ordinary outline nothing here is more than a couple of dozen rows.
 */
export async function blockView(tenant: TenantDb, grant: Grant, id: string): Promise<ScopedGraph> {
  const [visible, above, below] = await Promise.all([
    visibleFor(tenant, grant),
    linksAbove(tenant, [id]),
    linksFrom(tenant, [id]),
  ])
  const rows = new Rows().add(above).add(below)
  return makeScopedGraph(await rows.complete(tenant, id), visible)
}

/**
 * A block and the subtree beneath it, `depth` levels deep — what
 * `list_children` reads.
 *
 * Purely downward: `list_children` asks nothing about what holds the block, so
 * nothing walks up. The walk goes one level past the deepest block that will
 * be emitted, which is what lets a cut-off block be marked `hasMoreChildren`
 * (invariant 2).
 */
export async function subtreeView(
  tenant: TenantDb,
  grant: Grant,
  id: string,
  depth: number,
): Promise<ScopedGraph> {
  const [visible, below] = await Promise.all([
    visibleFor(tenant, grant),
    linksBelow(tenant, [id], depth),
  ])
  return makeScopedGraph(await new Rows().add(below).complete(tenant, id), visible)
}

/**
 * A block's ancestry — what `list_parents` reads.
 *
 * Three things, in the order they depend on each other: the upward closure
 * (the parents, and the notes that reach the block); each parent's own child
 * links, because a parent is handed back as a full block row and a block row
 * carries its `childIds`; and the SUBTREE of every note in that closure,
 * because an untitled note's display name is derived from its outline
 * (`noteFromNode`) and this tool names the notes a block is in.
 *
 * That last read is what makes `list_parents` cost O(the notes holding the
 * block) rather than O(1). It is still bounded by those notes rather than by
 * the corpus, and paying it is the price of the title being the one the person
 * sees rather than a second guess at it.
 */
export async function parentsView(
  tenant: TenantDb,
  grant: Grant,
  id: string,
): Promise<ScopedGraph> {
  const [visible, above, seed] = await Promise.all([
    visibleFor(tenant, grant),
    linksAbove(tenant, [id]),
    nodesByIds(tenant, [id]),
  ])
  const rows = new Rows().add(above).addNodes(seed)

  const parents = above.links
    .filter((link) => link.destination_id === id)
    .map((link) => link.source_id)
  // The notes come off the closure's own node rows, so they are exactly the
  // notes that reach the block (plus the block itself when it IS a note, which
  // is what `notesReaching` reports for one).
  const notes = [...above.nodes, ...seed]
    .filter((row) => row.type === NOTE_TYPE)
    .map((row) => row.id)

  const [children, subtrees] = await Promise.all([
    linksFrom(tenant, parents),
    linksBelow(tenant, notes, null),
  ])
  rows.add(children).add(subtrees)

  return makeScopedGraph(await rows.complete(tenant, id), visible)
}

/**
 * One note: its outline and its Unassigned section — what `read_note` reads.
 *
 * It loads the note's WHOLE subtree regardless of `depth`, and that is not an
 * oversight. `blockCount` is the note's true size and `noteFromNode` derives
 * the title, tags, tasks and preview from every block in it, so both are
 * whole-note facts; `depth` bounds what is RETURNED, never what is read. The
 * saving here is O(note) against O(corpus), not O(depth).
 *
 * Then the basket. Its candidates are the blocks written in the note
 * (`notes_id`), and the question `basketRootIds` asks of each is "does no note
 * reach it?". A candidate the note's own subtree reached is visibly reached
 * already; for the rest, the upward closure brings in every other note that
 * reaches one, so the answer cannot be a false "unassigned" (invariant 3).
 * Those loose blocks are also walked down `depth` levels, because the basket
 * is shown with its contents exactly as the outline is.
 */
export async function noteView(
  tenant: TenantDb,
  grant: Grant,
  noteId: string,
  depth: number,
): Promise<ScopedGraph> {
  const [visible, outline, written] = await Promise.all([
    visibleFor(tenant, grant),
    linksBelow(tenant, [noteId], null),
    nodesWrittenIn(tenant, noteId),
  ])
  const rows = new Rows().add(outline).addNodes(written)

  const reached = new Set(outline.links.map((link) => link.destination_id))
  const loose = written
    .filter((row) => row.id !== noteId && !reached.has(row.id))
    .map((row) => row.id)
  if (loose.length > 0) {
    const [ancestry, beneath] = await Promise.all([
      linksAbove(tenant, loose),
      linksBelow(tenant, loose, depth === 0 ? null : depth),
    ])
    rows.add(ancestry).add(beneath)
  }

  return makeScopedGraph(await rows.complete(tenant, noteId), visible)
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

/** A visible NOTE node, or null — what every note-addressed tool starts with. */
export function noteNodeOf(graph: ScopedGraph, id: string) {
  const row = nodeOf(graph, id)
  return row !== null && row.type === NOTE_TYPE ? row : null
}

/** A note's `Note` — title, tags, tasks, headings, preview text — exactly as
 * the app derives it. Null when the id is not a visible note. */
export function noteOf(graph: ScopedGraph, id: string): Note | null {
  return noteNodeOf(graph, id) === null ? null : noteFromNode(id, graph.snapshot)
}

/**
 * The roots of a note's **Unassigned** section: the blocks written in it that
 * no note reaches any more, in the order the app shows them
 * (`basketRootIds`, src/data/basket.ts).
 *
 * Reusing the app's own definition matters more here than anywhere else,
 * because "unassigned" is a subtle predicate: it is *no note reaches it*, not
 * *it has no parent* — two orphaned blocks holding each other both have a
 * parent and neither can be seen — and a loop with no root at all still has
 * to be shown. Restating any of that here would be a second definition to get
 * wrong.
 *
 * Reachability is computed over the WHOLE corpus, not the grant's slice: a
 * block some non-granted note still holds is not unassigned, and must not be
 * reported as though it were. The grant filters the answer, not the question.
 *
 * Returns the roots only; the caller walks them like any other blocks, so an
 * Unassigned subtree obeys the same `depth` as the outline.
 */
export function unassignedOf(graph: ScopedGraph, noteId: string): string[] | null {
  if (noteNodeOf(graph, noteId) === null) return null
  return basketRootIds(noteId, graph.snapshot).filter((id) => sees(graph, id))
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

/** Which visible notes reach this node — "what notes is this block in?". */
export const notesReaching = (graph: ScopedGraph, id: string): string[] =>
  sees(graph, id) ? (graph.noteIndex().get(id) ?? []) : []

/**
 * Every note in the corpus that reaches this node, **with the grant's filter
 * deliberately not applied**.
 *
 * The one read in this module that ignores the scope, and it exists for the
 * write path. The same block can hang in several notes, so editing it changes
 * what each of them shows. A token scoped to note A editing a block that note
 * B also holds would be a write landing outside its grant — invisible to it,
 * and to anyone reading the grant. `sharedOutsideScope` (tools.ts) asks this
 * question before every block write and refuses when the answer includes a
 * note the grant does not name.
 *
 * It reveals nothing: the caller learns only that *some* note it cannot see
 * holds the block, which is why the refusal message says that and not which.
 */
export function notesReachingUnscoped(graph: ScopedGraph, id: string): string[] {
  const reaching: string[] = []
  for (const noteId of noteIds(graph.snapshot)) {
    if (noteId === id || reachableFrom(graph.snapshot, [noteId]).has(id)) reaching.push(noteId)
  }
  return reaching.sort()
}

/** A node's child links, in order — the write path needs their sort keys, not
 * just the ids `childrenOf` gives. */
export const childLinksOf = (graph: ScopedGraph, id: string) =>
  sees(graph, id) ? (graph.snapshot.childLinks.get(id) ?? []) : []

/** A node's props as an object, or null. */
export const propsOf = (graph: ScopedGraph, id: string): Record<string, unknown> | null => {
  const row = nodeOf(graph, id)
  return row ? parseProps(row.props) : null
}

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
