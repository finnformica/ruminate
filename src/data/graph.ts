import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing"
import { isTombstoned, type LinkRow, type NodeRow } from "../../worker/handlers/replica-payload"
import { blockId } from "../blocks/id"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import { asBlockType, type Block, type BlockDoc, type BlockProps } from "../blocks/types"
import { keyOf, type ExpandedRule } from "../blocks/view"
import type { NoteId } from "../schema"
import { emittedNoteTitle } from "./note-identity"

/**
 * The graph ↔ doc seam (docs/graph-schema-v2.md).
 *
 * - `docFromGraph` / `noteDoc` — the **walk**: start at some root nodes,
 *   follow `child` links in sort-key order, and hand back a `BlockDoc` — the
 *   typed, marker-free slice of the graph the editor renders and edits. A
 *   node reached from two parents is in the doc once, named by both parents'
 *   `children` (that is the feature), and so is a loop: a node's `children`
 *   may name a node above it. Every walk over a doc guards by path
 *   (`walkDoc`, src/blocks/view.ts), showing a loop where it closes and no
 *   further.
 * - `rollup` — the markdown **projection** of one note: `serialize` over that
 *   note's doc. There is one walk and one emitter in the codebase.
 * - `docToParts` — the **write** direction: a doc's typed blocks become node
 *   rows and per-parent child orders, with no markdown in between. `docToOps`
 *   diffs those against the snapshot into ops, which the store applies
 *   verbatim. Markdown enters only through `parse` (`docToGraph`, the import
 *   path).
 *
 * The invariant everything rests on: for canonical markdown (the fixpoint of
 * `serialize(parse(md))`), `rollup(docToGraph(md))` is itself a fixpoint of
 * the round trip — and for markdown already in normalized form it reproduces
 * the input byte-for-byte. Two deliberate departures happen on import (so
 * the round trip is a *convergence*, not always an identity —
 * docs/graph-storage.md): near-miss marker spellings are typed
 * (`src/blocks/normalize-block-text.ts`), and a leading frontmatter block is
 * dropped — metadata is the note node's props, never markdown.
 */

export const CHILD_KIND = "child"
export const NOTE_TYPE = "note"

interface GraphParts {
  nodes: NodeRow[]
  /** Ordered child ids per parent; the note id keys the root list. */
  childrenOf: Map<string, string[]>
  /** The parents each block names beneath it, for blocks walked upstream
   * (`Block.upstream`); the note id keys the doc's own `upstream`. */
  upstreamOf: Map<string, string[]>
}

export const propsJson = (props: BlockProps | null | undefined): string | null =>
  props && Object.keys(props).length > 0 ? JSON.stringify(props) : null

/**
 * A doc's node rows + desired child orders (no sort keys yet — `docToGraph`
 * assigns fresh evenly-spaced ones; the store reconciles against existing
 * keys instead so unchanged siblings keep their rows). Nothing here reads
 * markdown: the doc's blocks are already typed and marker-free.
 *
 * `reservedIds` are ids a block row must never take (the store passes every
 * other note's id): block ids and note ids share the `nodes` table, so a block
 * declaring `id:: <noteId>` — or the id of another existing note — would
 * clobber that note's node row and the note would stop rolling up entirely.
 * Such ids are re-minted here: content survives (never-lose-work), and the
 * fresh id persists on the next save.
 */
export function docToParts(
  noteId: NoteId,
  doc: BlockDoc,
  updatedAt: number,
  reservedIds?: ReadonlySet<string>,
): GraphParts {
  const rename = new Map<string, string>()
  for (const id of Object.keys(doc.blocks)) {
    if (id !== noteId && !reservedIds?.has(id)) continue
    // Another note walked into this doc as a row (upstream) IS that note,
    // not a block wearing its id: it keeps it.
    if (doc.blocks[id].type === NOTE_TYPE && id !== noteId) continue
    let fresh = blockId()
    while (doc.blocks[fresh] !== undefined || fresh === noteId || reservedIds?.has(fresh)) {
      fresh = blockId()
    }
    rename.set(id, fresh)
  }
  const safeId = (id: string) => rename.get(id) ?? id

  // The title is data: the note node's `text`. It rides the doc's props as
  // `title` (`note-identity.ts`) and is lifted out here, so it is never stored
  // twice and the walk re-emits it from the one place that owns it.
  const { title, ...rest } = doc.props ?? {}
  const titled = typeof title === "string"
  const nodes: NodeRow[] = [
    {
      id: noteId,
      type: NOTE_TYPE,
      // No title means an untitled note (or a date note, whose id IS its
      // name) — `text` stays the id, exactly as it was before minting.
      text: titled ? title : noteId,
      // A note whose only prop was its title holds none; an empty props
      // object is kept distinct from null, as the rows keep it.
      props:
        doc.props === null || (titled && Object.keys(rest).length === 0)
          ? null
          : JSON.stringify(rest),
      updated_at: updatedAt,
    },
  ]
  const childrenOf = new Map<string, string[]>()
  const upstreamOf = new Map<string, string[]>()

  // Depth-first from the roots: node rows in document order, and each block's
  // child order once (a block reached from two parents is one row, and its
  // children are the same wherever it is). A block walked upstream (a parent
  // shown beneath a row) is visited the same way, so its own row and lists
  // take part in the diff.
  const seen = new Set<string>()
  const visit = (id: string) => {
    const block = doc.blocks[id]
    if (!block || seen.has(id)) return
    seen.add(id)
    nodes.push({
      id: safeId(id),
      type: block.type,
      text: block.text,
      props: propsJson(block.props),
      updated_at: updatedAt,
    })
    walk(safeId(id), block.children)
    if (block.upstream) {
      upstreamOf.set(safeId(id), block.upstream.map(safeId))
      for (const parentId of block.upstream) visit(parentId)
    }
  }
  const walk = (parentId: string, ids: string[]) => {
    childrenOf.set(parentId, ids.map(safeId))
    for (const id of ids) visit(id)
  }
  walk(noteId, doc.rootBlockIds)
  if (doc.upstream) {
    upstreamOf.set(noteId, doc.upstream.map(safeId))
    for (const parentId of doc.upstream) visit(parentId)
  }

  return { nodes, childrenOf, upstreamOf }
}

/**
 * Ingest one note: markdown → typed blocks (`parse`) → node + link rows, with
 * fresh evenly-spaced sort keys per parent (which doubles as the rebalancing
 * mechanism — see the schema doc). `props` are the note's metadata, which
 * markdown never carries. The app's own saves use `docToOps` instead, so
 * unchanged rows stay untouched.
 */
export function docToGraph(
  noteId: NoteId,
  markdown: string,
  updatedAt: number,
  props: BlockProps | null = null,
): { nodes: NodeRow[]; links: LinkRow[] } {
  const { nodes, childrenOf } = docToParts(noteId, { ...parse(markdown), props }, updatedAt)
  const links: LinkRow[] = []
  for (const [sourceId, childIds] of childrenOf) {
    const keys = generateNKeysBetween(null, null, childIds.length)
    childIds.forEach((destinationId, i) => {
      links.push({
        source_id: sourceId,
        destination_id: destinationId,
        kind: CHILD_KIND,
        sort_key: keys[i],
        updated_at: updatedAt,
      })
    })
  }
  return { nodes, links }
}

/**
 * Assign sort keys for a parent's desired child order, reusing existing keys
 * wherever the relative order allows so an unchanged sibling produces no row
 * change. Greedy increasing-subsequence over the old keys; gaps get fresh keys
 * generated between their kept neighbours.
 */
export function reconcileSortKeys(
  existing: { id: string; sortKey: string }[],
  desired: string[],
): Map<string, string> {
  const oldKey = new Map(existing.map((e) => [e.id, e.sortKey]))
  const keys = new Map<string, string>()

  // Which desired children keep their old key: old keys must remain strictly
  // increasing in the new order.
  const kept: (string | null)[] = []
  let lastKept: string | null = null
  for (const id of desired) {
    const key = oldKey.get(id)
    if (key !== undefined && (lastKept === null || key > lastKept)) {
      kept.push(key)
      lastKept = key
    } else {
      kept.push(null)
    }
  }

  // Fill each run of non-kept children with keys between its kept neighbours.
  let i = 0
  while (i < desired.length) {
    if (kept[i] !== null) {
      keys.set(desired[i], kept[i] as string)
      i += 1
      continue
    }
    let end = i
    while (end < desired.length && kept[end] === null) end += 1
    const before = i > 0 ? (kept[i - 1] as string) : null
    const after = end < desired.length ? (kept[end] as string) : null
    const fresh = generateNKeysBetween(before, after, end - i)
    for (let j = i; j < end; j += 1) keys.set(desired[j], fresh[j - i])
    i = end
  }

  return keys
}

/** A fresh key strictly between two neighbours (either side may be open). */
export function sortKeyBetween(a: string | null, b: string | null): string {
  return generateKeyBetween(a, b)
}

// -----------------------------------------------------------------------------
// The walk: graph → doc
// -----------------------------------------------------------------------------

export interface GraphSnapshot {
  nodes: Map<string, NodeRow>
  /** Child links per source, sorted by sort key (destination id tiebreak). */
  childLinks: Map<string, LinkRow[]>
  /**
   * The same links per destination, sorted by source id: who holds a node.
   * The reverse index is a by-product of building the snapshot, never
   * computed by scanning it — `buildGraphSnapshot` fills both directions from
   * one pass over the rows, `applyOps` maintains both per op, and every
   * reader that needs a node's parents (the delete menu's place count, the
   * basket's roots, the walk upstream) reads it in O(1).
   */
  parentLinks: Map<string, LinkRow[]>
}

/** Parent order: by source id — unique per destination, so never a tie. */
const byParent = (a: LinkRow, b: LinkRow) =>
  a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : 0

/** The reverse index of a set of child-link lists: the same rows keyed by
 * destination, sorted by source id. Used wherever `childLinks` is built or
 * merged wholesale, so the two directions cannot drift. */
export function indexParents(childLinks: ReadonlyMap<string, LinkRow[]>): Map<string, LinkRow[]> {
  const parentLinks = new Map<string, LinkRow[]>()
  for (const list of childLinks.values()) {
    for (const link of list) {
      const parents = parentLinks.get(link.destination_id)
      if (parents) parents.push(link)
      else parentLinks.set(link.destination_id, [link])
    }
  }
  for (const list of parentLinks.values()) list.sort(byParent)
  return parentLinks
}

/**
 * Index rows for walking, in both directions (`childLinks` by source,
 * `parentLinks` by destination). Only `child` links participate in containment.
 *
 * **Read-time discard is enforced here**, once, for every reader: a tombstoned
 * node is not in the snapshot at all, and a link is dropped if it is itself
 * tombstoned or if either endpoint is. Deletes therefore never cascade at
 * write time — a link to a deleted node is kept in storage (it is the position
 * a restore would put the node back into) and simply not traversed.
 *
 * A link to a node that is *absent* rather than tombstoned is a different
 * thing — a dangling edge from a bad sync — and keeps its long-standing
 * behavior: it stays in the index and the walk skips over it, which is what
 * makes an ordered run break where the missing sibling was.
 */
export function buildGraphSnapshot(nodes: NodeRow[], links: LinkRow[]): GraphSnapshot {
  const nodeMap = new Map<string, NodeRow>()
  const tombstoned = new Set<string>()
  for (const node of nodes) {
    if (isTombstoned(node)) tombstoned.add(node.id)
    else nodeMap.set(node.id, node)
  }
  const childLinks = new Map<string, LinkRow[]>()
  for (const link of links) {
    if (link.kind !== CHILD_KIND) continue
    if (isTombstoned(link)) continue
    if (tombstoned.has(link.source_id) || tombstoned.has(link.destination_id)) continue
    const list = childLinks.get(link.source_id)
    if (list) list.push(link)
    else childLinks.set(link.source_id, [link])
  }
  for (const list of childLinks.values()) {
    // Deterministic sibling order even under a sort-key collision (concurrent
    // same-gap inserts on two devices): destination id breaks the tie.
    list.sort((a, b) =>
      a.sort_key < b.sort_key
        ? -1
        : a.sort_key > b.sort_key
          ? 1
          : a.destination_id < b.destination_id
            ? -1
            : 1,
    )
  }
  return { nodes: nodeMap, childLinks, parentLinks: indexParents(childLinks) }
}

/** Ordered child ids of a node. */
export function childIdsOf(graph: GraphSnapshot, id: string): string[] {
  return (graph.childLinks.get(id) ?? []).map((link) => link.destination_id)
}

/** The ids of the nodes holding a node (its parents), in source-id order. */
export function parentIdsOf(graph: GraphSnapshot, id: string): string[] {
  return (graph.parentLinks.get(id) ?? []).map((link) => link.source_id)
}

/** A node's props as an object, or null — tolerant of malformed JSON (a bad
 * row renders without its props rather than not at all). */
export function parseProps(props: string | null): BlockProps | null {
  if (props === null) return null
  try {
    const parsed: unknown = JSON.parse(props)
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as BlockProps)
      : null
  } catch {
    return null
  }
}

/** A walk's result: the doc, and the keys the fold rule closed — the rows
 * drawn with a chevron and nothing beneath them. */
export interface GraphView {
  doc: BlockDoc
  collapsed: Set<string>
}

/**
 * Which links a view follows from a row (Settings → Editor, "Show links"):
 * downstream — what a block holds, the tree; upstream — what holds it, its
 * parents shown beneath it after its children; or both, the graph
 * (docs/graph-schema-v2.md, "Upstream").
 */
export type LinkDirections = "downstream" | "upstream" | "both"

/** Every occurrence open: the eager walk (export, search, the basket). */
const EVERYTHING_OPEN: ExpandedRule = () => true

/** The options a walk takes. */
export interface WalkOptions {
  /** The fold rule; absent = every occurrence open. */
  expanded?: ExpandedRule
  /** The level of the roots (1 for a note's children; 0 for a focused block). */
  startLevel?: number
  /** Which links to follow; `"downstream"` by default — the tree. */
  directions?: LinkDirections
  /** The id of the view's own root when it is not a block in the doc (the
   * note): on the path from the start, so a root's parent that is the note
   * is never listed beneath it. With `directions` upstream, the root's own
   * parents are the doc's `upstream`, rows after the roots. */
  rootId?: string
}

/**
 * The walk: a `BlockDoc` of what `rootIds` reach over child links, in
 * sort-key order — the typed slice of the graph a view renders — descended
 * only where `expanded` says an occurrence is open.
 *
 * The walk is LAZY (the shape the results view pioneered, `resultsDoc`).
 * Every block it touches carries its complete list of children's ids — the
 * graph's, exactly, which is what draws the fold chevron and keeps a save
 * diff to nothing — but the children themselves are walked in only beneath
 * an occurrence the rule opens. A closed occurrence is a row with a chevron
 * and nothing beneath it, and its key is in `collapsed`; opening it walks
 * one more level. So the doc is O(what is on screen), however large the
 * graph, and the same call serves a note (its children as the roots, level
 * 1) and a focused block (the block as the root, level 0): a view from any
 * root is the same walk.
 *
 * - A root that does not exist is skipped; the doc's `rootBlockIds` are the
 *   roots that do, in the order given.
 * - Every walked node is in `blocks` once, however many parents name it; a
 *   block reached again by a second, open path is walked beneath it there.
 *   A dangling link (destination row missing) is dropped from its parent's
 *   `children`, exactly as the rollup has always skipped it.
 * - A node already on the current path (a loop back to a node above) is
 *   named where it is reached and never descended, so the walk ends where
 *   the loop closes (docs/graph-schema-v2.md, "Loops").
 * - Unknown node types (a newer client's) become `text`, marker-free.
 *
 * The note node itself is not part of a note's doc (see `noteDoc`); pass a
 * note id as a root and it walks like any node — a note linked under a block
 * renders as a `note` block.
 *
 * Walked **upstream** as well (`directions`), every block also carries the
 * complete list of its parents' ids (`upstream`), and beneath an open row
 * the walk continues into its parents after its children — each an upstream
 * occurrence (`^` in the key, src/blocks/view.ts), walked on by the same
 * rule in both directions. A parent already on the path above is skipped
 * (a block's own parent is where the row came from, not something beneath
 * it), which is what keeps a single-homed block's rows exactly the tree's
 * and shows only the *other* places a multi-homed block is held. The view
 * is then the graph around the root, as far as the folds open it.
 */
export function walkGraph(
  rootIds: string[],
  graph: GraphSnapshot,
  {
    expanded = EVERYTHING_OPEN,
    startLevel = 1,
    directions = "downstream",
    rootId,
  }: WalkOptions = {},
): GraphView {
  const down = directions !== "upstream"
  const up = directions !== "downstream"
  const blocks: Record<string, Block> = {}
  const collapsed = new Set<string>()
  const path = new Set<string>()
  if (rootId) path.add(rootId)

  // The live ids a node holds, and (upstream) the live ids holding it.
  const childrenOf = (id: string) =>
    // A node listed as its own child (a corrupted row; the write side never
    // makes one) is skipped: that loop has no closing row to show. So is a
    // dangling link.
    childIdsOf(graph, id).filter((childId) => childId !== id && graph.nodes.has(childId))
  const parentsOf = (id: string) =>
    parentIdsOf(graph, id).filter((parentId) => parentId !== id && graph.nodes.has(parentId))

  // A block with its complete lists, built once — never walked here.
  const blockOf = (id: string): Block | null => {
    const known = blocks[id]
    if (known) return known
    const node = graph.nodes.get(id)
    if (!node) return null
    const props = parseProps(node.props)
    // `props` only when there are any: a walked doc and a parsed one must be
    // the same object, key for key (the walk-equals-parse invariant).
    const block: Block = {
      id,
      type: asBlockType(node.type),
      text: node.text,
      ...(props ? { props } : {}),
      children: childrenOf(id),
      ...(up ? { upstream: parentsOf(id) } : {}),
    }
    blocks[id] = block
    return block
  }

  const visit = (
    id: string,
    parentKey: string | null,
    level: number,
    direction: "down" | "up",
  ): boolean => {
    // Reached again from above (or the view's own root): the loop closes
    // here, as a leaf — named, not built again, never descended.
    if (path.has(id)) return graph.nodes.has(id)
    const block = blockOf(id)
    if (!block) return false
    const key = keyOf(parentKey, id, direction)
    // Beneath a parent row, the block it was reached up from is not a row.
    const beneathDown = !down
      ? []
      : direction === "up"
        ? block.children.filter((childId) => !path.has(childId))
        : block.children
    const beneathUp = up ? (block.upstream ?? []).filter((parentId) => !path.has(parentId)) : []
    if (beneathDown.length === 0 && beneathUp.length === 0) return true
    if (!expanded(key, level)) {
      collapsed.add(key)
      return true
    }
    path.add(id)
    for (const childId of beneathDown) visit(childId, key, level + 1, "down")
    for (const parentId of beneathUp) visit(parentId, key, level + 1, "up")
    path.delete(id)
    return true
  }

  const rootBlockIds = rootIds.filter((id) => visit(id, null, startLevel, "down"))
  const doc: BlockDoc = { props: null, rootBlockIds, blocks }
  if (up && rootId) {
    // The root's own parents: rows after the roots, at the roots' level.
    const upstream = parentsOf(rootId)
    doc.upstream = upstream.filter((parentId) => visit(parentId, null, startLevel, "up"))
  }
  return { doc, collapsed }
}

/** The eager walk: everything `rootIds` reach, every occurrence open. */
export function docFromGraph(rootIds: string[], graph: GraphSnapshot): BlockDoc {
  return walkGraph(rootIds, graph).doc
}

/**
 * A note's doc — what the note page edits: the note's children as the roots,
 * and the note's props (with `title` put back from the note node's `text` —
 * `note-identity.ts`) as the doc's props, so `docToParts` of this doc is the
 * note's rows and `serialize` of it is the note's rollup. Null when the note
 * node does not exist.
 */
export function noteDoc(noteId: string, graph: GraphSnapshot): BlockDoc | null {
  return noteView(noteId, graph)?.doc ?? null
}

/**
 * A note's view: `noteDoc`, walked lazily by the reader's fold rule — the
 * note page's doc, and the keys it folded. Null when the note node does not
 * exist. Without a rule, every occurrence is open (`noteDoc`).
 */
export function noteView(
  noteId: string,
  graph: GraphSnapshot,
  expanded?: ExpandedRule,
  directions: LinkDirections = "downstream",
): GraphView | null {
  const note = graph.nodes.get(noteId)
  if (!note || note.type !== NOTE_TYPE) return null
  const entries = noteEntries(note.props)
  const title = emittedNoteTitle(note.id, note.text)
  const props = title !== null ? { title, ...(entries ?? {}) } : entries
  // Upstream only, the note's blocks are still the roots — a root is always
  // shown — but nothing beneath them is followed down.
  const { doc, collapsed } = walkGraph(childIdsOf(graph, noteId), graph, {
    expanded,
    directions,
    rootId: noteId,
  })
  return { doc: { ...doc, props }, collapsed }
}

/**
 * A block's view — the focused page: the block as the doc's one root, at
 * level 0 (always open; the editor draws it as the view's title), its
 * children the rows at level 1, walked by the same rule as a note is. A view
 * from any root is the same walk. Null when the block does not exist, or is
 * a note (a note is opened as a note).
 */
export function blockView(
  blockId: string,
  graph: GraphSnapshot,
  expanded?: ExpandedRule,
  directions: LinkDirections = "downstream",
): GraphView | null {
  const node = graph.nodes.get(blockId)
  if (!node || node.type === NOTE_TYPE) return null
  return walkGraph([blockId], graph, { expanded, startLevel: 0, directions })
}

/**
 * The ids from a root down to a block — the roots' child first, the block
 * last — by the shortest chain of child links, or null when the root does
 * not reach the block. Empty when the block IS the root. Found by walking
 * UP from the block over the reverse index, so the cost tracks the block's
 * depth, not the size of what the root holds; what a view uses to open the
 * folds along the way to a block it must show (stepping back onto it).
 */
export function pathToBlock(
  graph: GraphSnapshot,
  rootId: string,
  blockId: string,
): string[] | null {
  if (rootId === blockId) return []
  if (!graph.nodes.has(blockId)) return null
  // Breadth-first upward: the first time the root is met is a shortest chain.
  const via = new Map<string, string>([[blockId, blockId]])
  const queue = [blockId]
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i]
    for (const parent of parentIdsOf(graph, id)) {
      if (via.has(parent)) continue
      via.set(parent, id)
      if (parent === rootId) {
        const chain: string[] = []
        for (let at = id; at !== blockId; at = via.get(at) as string) chain.push(at)
        chain.push(blockId)
        return chain
      }
      queue.push(parent)
    }
  }
  return null
}

/** A note row's props as entries — an object even when empty, null for none
 * or malformed. */
function noteEntries(props: string | null): BlockProps | null {
  if (props === null) return null
  try {
    const parsed: unknown = JSON.parse(props)
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as BlockProps
  } catch {
    return null
  }
}

/**
 * Render one note node to markdown — the canonical serialization, exactly the
 * bytes the editor's `serialize` would produce for the same outline, because
 * it IS that: the note's doc, serialized. A node reached from two parents
 * renders fully in both places (that is the feature). Returns null when the
 * note node does not exist.
 */
export function rollup(noteId: string, graph: GraphSnapshot): string | null {
  const doc = noteDoc(noteId, graph)
  return doc ? serialize(doc) : null
}

/**
 * The same projection from a block root — the rollup of the focused page: the
 * block's own line, then everything beneath it, exactly the rows that view
 * shows. Focused in, this is what a note-level action works on, so what is
 * copied is what is on screen rather than the whole note it came from.
 * Returns null for a block the graph does not hold, or for a note node (a
 * note's rollup is `rollup`).
 */
export function blockRollup(blockId: string, graph: GraphSnapshot): string | null {
  const node = graph.nodes.get(blockId)
  if (!node || node.type === NOTE_TYPE) return null
  return serialize(docFromGraph([blockId], graph))
}
