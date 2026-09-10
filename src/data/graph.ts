import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing"
import { isTombstoned, type LinkRow, type NodeRow } from "../../worker/handlers/replica-payload"
import { blockId } from "../blocks/id"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import { asBlockType, type Block, type BlockDoc, type BlockProps } from "../blocks/types"
import type { NoteId } from "../schema"
import { frontmatterTextFromProps, pagePropsFromFrontmatter } from "./frontmatter-props"
import {
  emittedPageTitle,
  injectTitleIntoFrontmatter,
  liftTitleFromFrontmatter,
} from "./page-identity"

/**
 * The graph ↔ doc seam (docs/graph-schema-v2.md, docs/graph-native-app.md).
 *
 * - `docFromGraph` / `pageDoc` — the **walk**: start at some root nodes,
 *   follow `child` links in sort-key order, and hand back a `BlockDoc` — the
 *   typed, marker-free slice of the graph the editor renders and edits. A
 *   node reached from two parents is in the doc once, named by both parents'
 *   `children` (that is the feature); a back-edge (a corrupted, cyclic graph
 *   from a bad sync) is dropped so the slice is always a DAG.
 * - `rollup` — the markdown **projection** of one page: `serialize` over that
 *   page's doc. There is one walk and one emitter in the codebase.
 * - `docToParts` — the **write** direction: a doc's typed blocks become node
 *   rows and per-parent child orders, with no markdown in between. The store
 *   reconciles those against the rows it holds (`planNoteWrite`). Markdown
 *   enters only through `parse` (`docToGraphParts`, the import path).
 *
 * The invariant everything rests on: for canonical markdown (the fixpoint of
 * `serialize(parse(md))`), `rollup(docToGraph(md))` is itself a fixpoint of
 * the round trip — and for markdown already in normalized form it reproduces
 * the input byte-for-byte, frontmatter included. Two deliberate
 * normalizations happen on import (so the round trip is a *convergence*, not
 * always an identity — docs/graph-storage.md): near-miss marker spellings
 * are typed (`src/blocks/normalize-block-text.ts`), and frontmatter is stored
 * as parsed entries and re-emitted canonically (`frontmatter-props.ts`).
 */

export const CHILD_KIND = "child"
export const PAGE_TYPE = "page"

interface GraphParts {
  nodes: NodeRow[]
  /** Ordered child ids per parent; the page id keys the root list. */
  childrenOf: Map<string, string[]>
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
 * other page's id): block ids and page ids share the `nodes` table, so a block
 * declaring `id:: <noteId>` — or the id of another existing page — would
 * clobber that page's node row and the page would stop rolling up entirely.
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
    let fresh = blockId()
    while (doc.blocks[fresh] !== undefined || fresh === noteId || reservedIds?.has(fresh)) {
      fresh = blockId()
    }
    rename.set(id, fresh)
  }
  const safeId = (id: string) => rename.get(id) ?? id

  // The title is data, and it rides the `<id>.md` seam as a projection-owned
  // `title:` frontmatter key (`page-identity.ts`): lift it into the page node's
  // `text` and keep it OUT of `props`, so it is never stored twice and the
  // rollup can re-emit it from the one place that owns it.
  const { title, rest } = liftTitleFromFrontmatter(doc.frontmatter)
  const nodes: NodeRow[] = [
    {
      id: noteId,
      type: PAGE_TYPE,
      // No title key means an untitled page (or a date page, whose id IS its
      // name) — `text` stays the id, exactly as it was before minting.
      text: title ?? noteId,
      props: rest !== null ? pagePropsFromFrontmatter(rest) : null,
      updated_at: updatedAt,
    },
  ]
  const childrenOf = new Map<string, string[]>()

  // Depth-first from the roots: node rows in document order, and each block's
  // child order once (a block reached from two parents is one row, and its
  // children are the same wherever it is).
  const seen = new Set<string>()
  const walk = (parentId: string, ids: string[]) => {
    childrenOf.set(parentId, ids.map(safeId))
    for (const id of ids) {
      const block = doc.blocks[id]
      if (!block || seen.has(id)) continue
      seen.add(id)
      nodes.push({
        id: safeId(id),
        type: block.type,
        text: block.text,
        props: propsJson(block.props),
        updated_at: updatedAt,
      })
      walk(safeId(id), block.children)
    }
  }
  walk(noteId, doc.rootBlockIds)

  return { nodes, childrenOf }
}

/** The import path: markdown → typed blocks (`parse`) → rows. */
function docToGraphParts(
  noteId: NoteId,
  markdown: string,
  updatedAt: number,
  reservedIds?: ReadonlySet<string>,
): GraphParts {
  return docToParts(noteId, parse(markdown), updatedAt, reservedIds)
}

/**
 * Ingest one note: markdown → node + link rows, with fresh evenly-spaced sort
 * keys per parent (which doubles as the rebalancing mechanism — see the
 * schema doc). The store's diffing write path uses `docToParts` +
 * `reconcileSortKeys` instead, so unchanged rows stay untouched.
 */
export function docToGraph(
  noteId: NoteId,
  markdown: string,
  updatedAt: number,
): { nodes: NodeRow[]; links: LinkRow[] } {
  const { nodes, childrenOf } = docToGraphParts(noteId, markdown, updatedAt)
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
}

/**
 * Index rows for walking. Only `child` links participate in containment.
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
  return { nodes: nodeMap, childLinks }
}

/** Ordered child ids of a node. */
function childIdsOf(graph: GraphSnapshot, id: string): string[] {
  return (graph.childLinks.get(id) ?? []).map((link) => link.destination_id)
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

/**
 * The walk: a `BlockDoc` of everything reachable from `rootIds` over child
 * links, in sort-key order — the typed slice of the graph a view renders.
 *
 * - A root that does not exist is skipped; the doc's `rootBlockIds` are the
 *   roots that do, in the order given.
 * - Every reachable node is in `blocks` once, however many parents name it;
 *   a dangling link (destination row missing) is dropped from its parent's
 *   `children`, exactly as the rollup has always skipped it.
 * - A back-edge — a child that is also an ancestor on the current path, which
 *   only a corrupted (cyclic) graph can hold — is dropped, so the slice is a
 *   DAG that every walk over it (export, render, navigation) can finish.
 * - Unknown node types (a newer client's) become `text`, marker-free.
 *
 * The page node itself is not part of a page's doc (see `pageDoc`); pass a
 * page id as a root and it walks like any node — a page linked under a block
 * renders as a `page` block.
 */
export function docFromGraph(rootIds: string[], graph: GraphSnapshot): BlockDoc {
  const blocks: Record<string, Block> = {}
  const onPath = new Set<string>()

  const visit = (id: string): boolean => {
    const node = graph.nodes.get(id)
    if (!node) return false
    if (onPath.has(id)) return false // a back-edge: dropped
    if (blocks[id]) return true // reached again by another path: already built
    onPath.add(id)
    const props = parseProps(node.props)
    // `props` only when there are any: a walked doc and a parsed one must be
    // the same object, key for key (the walk-equals-parse invariant).
    const block: Block = {
      id,
      type: asBlockType(node.type),
      text: node.text,
      ...(props ? { props } : {}),
      children: [],
    }
    blocks[id] = block
    block.children = childIdsOf(graph, id).filter((childId) => visit(childId))
    onPath.delete(id)
    return true
  }

  const rootBlockIds = rootIds.filter((id) => visit(id))
  return { frontmatter: null, rootBlockIds, blocks }
}

/**
 * A page's doc — what the note page edits: the page's children as the roots,
 * and the page's frontmatter (its props, with the projection-owned `title:`
 * re-emitted from the page node's `text` — `page-identity.ts`) as the doc's
 * frontmatter text, so `serialize` of this doc is the page's rollup. Null
 * when the page node does not exist.
 */
export function pageDoc(pageId: string, graph: GraphSnapshot): BlockDoc | null {
  const page = graph.nodes.get(pageId)
  if (!page || page.type !== PAGE_TYPE) return null
  const stored = frontmatterTextFromProps(page.props)
  const title = emittedPageTitle(page.id, page.text)
  const frontmatter = title !== null ? injectTitleIntoFrontmatter(stored, title) : stored
  const doc = docFromGraph(childIdsOf(graph, pageId), graph)
  return { ...doc, frontmatter }
}

/**
 * Render one page node to markdown — the canonical serialization, exactly the
 * bytes the editor's `serialize` would produce for the same outline, because
 * it IS that: the page's doc, serialized. A node reached from two parents
 * renders fully in both places (that is the feature). Returns null when the
 * page node does not exist.
 */
export function rollup(pageId: string, graph: GraphSnapshot): string | null {
  const doc = pageDoc(pageId, graph)
  return doc ? serialize(doc) : null
}
