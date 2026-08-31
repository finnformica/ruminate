import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing"
import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import { blockId } from "../blocks/id"
import { parse } from "../blocks/parse"
import { normalizeHeadingMarker } from "../blocks/serialize"
import type { NoteId } from "../schema"

/**
 * Schema v2's two most load-bearing transforms (docs/graph-schema-v2.md):
 *
 * - `docToGraph` — ingest: parse a note's markdown and flatten it into
 *   `nodes` + `link` rows (typed nodes, marker-free text, fractional sort
 *   keys).
 * - `rollup` — projection: walk a page node's child links in sort-key order
 *   and serialize each node by type back to markdown.
 *
 * The invariant everything rests on: for canonical markdown (the fixpoint of
 * the editor's `serialize(parse(md))`), `rollup(docToGraph(md)) === md`
 * byte-for-byte, frontmatter included. Ingest therefore only strips a marker
 * when re-adding it reproduces the original line exactly; anything
 * non-canonical (`[X]`, `2)`, `* `, mismatched ordered numbers) stays verbatim
 * in a `text` node.
 */

export const CHILD_KIND = "child"
export const PAGE_TYPE = "page"

/**
 * The pure type→marker map — the serializer half of the type registry.
 * `ol` (renumbered), `code` (fenced), and `page` are handled structurally in
 * `rollup`. `h2`/`h3` exist for future minting; ingest only produces `h1`
 * because canonical markdown collapses all heading markers to `# ` (visual
 * level comes from outline depth).
 */
const MARKER_OF_TYPE: Record<string, string> = {
  text: "",
  h1: "# ",
  h2: "## ",
  h3: "### ",
  todo: "[ ] ",
  done: "[x] ",
  ul: "- ",
  quote: "> ",
}

/** Renderer walk depth cap — belt-and-braces so even a corrupted graph (bad
 * sync merge introducing a cycle) can never hang the rollup. */
const MAX_ROLLUP_DEPTH = 64

const OL_RE = /^(0|[1-9]\d*)\. /

/**
 * Classify one canonical content line into `{type, text}`. `olPosition` is the
 * 1-based position the line would take in the current run of consecutive
 * ordered siblings — an ordered marker is only typed `ol` when its number
 * matches, because the serializer renumbers by run position and any other
 * number must survive verbatim.
 */
function classifyLine(
  line: string,
  olPosition: number,
  inFence: boolean,
): { type: string; text: string } {
  if (!inFence) {
    for (const [type, marker] of Object.entries(MARKER_OF_TYPE)) {
      if (marker !== "" && line.startsWith(marker)) {
        return { type, text: line.slice(marker.length) }
      }
    }
    const ordered = OL_RE.exec(line)
    if (ordered && ordered[1] === String(olPosition)) {
      return { type: "ol", text: line.slice(ordered[0].length) }
    }
  }
  return { type: "text", text: line }
}

interface GraphParts {
  nodes: NodeRow[]
  /** Ordered child ids per parent; the page id keys the root list. */
  childrenOf: Map<string, string[]>
}

/**
 * Parse a note and produce its node rows + desired child orders (no sort keys
 * yet — `docToGraph` assigns fresh evenly-spaced ones; the store reconciles
 * against existing keys instead so unchanged siblings keep their rows).
 *
 * `reservedIds` are ids a block row must never take (the store passes every
 * other page's id): block ids and page ids share the `nodes` table, so a block
 * declaring `id:: <noteId>` — or the id of another existing page — would
 * clobber that page's node row and the page would stop rolling up entirely.
 * Such ids are re-minted here: content survives (never-lose-work), and the
 * fresh id persists on the next save.
 */
export function docToGraphParts(
  noteId: NoteId,
  markdown: string,
  updatedAt: number,
  reservedIds?: ReadonlySet<string>,
): GraphParts {
  const doc = parse(markdown)

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

  // Pass 1 — code-fence state per block, over the exact line order the
  // serializer emits (depth-first). A line inside an open fence must never be
  // typed by its marker: `- [ ]` in a fence is code, not a todo.
  const inFence = new Map<string, boolean>()
  let fenceOpen = false
  const scanFences = (ids: string[]) => {
    for (const id of ids) {
      const block = doc.blocks[id]
      if (!block) continue
      inFence.set(id, fenceOpen)
      if (block.content.trimStart().startsWith("```")) fenceOpen = !fenceOpen
      scanFences(block.children)
    }
  }
  scanFences(doc.rootBlockIds)

  const nodes: NodeRow[] = [
    {
      id: noteId,
      type: PAGE_TYPE,
      text: noteId,
      props: doc.frontmatter !== null ? JSON.stringify({ frontmatter: doc.frontmatter }) : null,
      updated_at: updatedAt,
    },
  ]
  const childrenOf = new Map<string, string[]>()

  // Pass 2 — type each block. The ordered-run position is tracked per parent
  // over its (consecutive) children, mirroring the rollup's renumbering.
  const walk = (parentId: string, ids: string[]) => {
    childrenOf.set(parentId, ids.map(safeId))
    let olRun = 0
    for (const id of ids) {
      const block = doc.blocks[id]
      if (!block) continue
      // Canonical content first: the serializer collapses `##`+ heading
      // markers to `#` on the way out, so ingest sees what serialize emits.
      const line = normalizeHeadingMarker(block.content)
      const { type, text } = classifyLine(line, olRun + 1, inFence.get(id) ?? false)
      olRun = type === "ol" ? olRun + 1 : 0
      nodes.push({ id: safeId(id), type, text, props: null, updated_at: updatedAt })
      walk(safeId(id), block.children)
    }
  }
  walk(noteId, doc.rootBlockIds)

  return { nodes, childrenOf }
}

/**
 * Ingest one note: markdown → node + link rows, with fresh evenly-spaced sort
 * keys per parent (which doubles as the rebalancing mechanism — see the
 * schema doc). The store's diffing write path uses `docToGraphParts` +
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
// Rollup
// -----------------------------------------------------------------------------

export interface GraphSnapshot {
  nodes: Map<string, NodeRow>
  /** Child links per source, sorted by sort key (destination id tiebreak). */
  childLinks: Map<string, LinkRow[]>
}

/** Index rows for walking. Only `child` links participate in containment. */
export function buildGraphSnapshot(nodes: NodeRow[], links: LinkRow[]): GraphSnapshot {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]))
  const childLinks = new Map<string, LinkRow[]>()
  for (const link of links) {
    if (link.kind !== CHILD_KIND) continue
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

/** The page node's raw frontmatter text, or null. Tolerant of malformed props. */
function pageFrontmatter(page: NodeRow): string | null {
  if (page.props === null) return null
  try {
    const props: unknown = JSON.parse(page.props)
    const frontmatter = (props as { frontmatter?: unknown } | null)?.frontmatter
    return typeof frontmatter === "string" ? frontmatter : null
  } catch {
    return null
  }
}

const codeLanguage = (node: NodeRow): string => {
  if (node.props === null) return ""
  try {
    const language = (JSON.parse(node.props) as { language?: unknown } | null)?.language
    return typeof language === "string" ? language : ""
  } catch {
    return ""
  }
}

/**
 * Render one page node to markdown — the canonical serialization, exactly the
 * bytes the editor's `serialize` would produce for the same outline. A node
 * reached from two parents renders fully in both places (that is the feature).
 * Returns null when the page node does not exist.
 */
export function rollup(pageId: string, graph: GraphSnapshot): string | null {
  const page = graph.nodes.get(pageId)
  if (!page || page.type !== PAGE_TYPE) return null

  const lines: string[] = []
  const frontmatter = pageFrontmatter(page)
  if (frontmatter !== null) {
    lines.push("---", frontmatter, "---")
  }

  const emitNode = (id: string, depth: number, olPosition: number) => {
    const node = graph.nodes.get(id)
    if (!node) return
    const indent = "  ".repeat(depth)

    if (node.type === "code") {
      lines.push(`${indent}\`\`\`${codeLanguage(node)}`)
      for (const line of node.text.split("\n")) lines.push(`${indent}${line}`)
      lines.push(`${indent}\`\`\``)
    } else {
      const marker = node.type === "ol" ? `${olPosition}. ` : (MARKER_OF_TYPE[node.type] ?? "")
      const [first, ...rest] = node.text.split("\n")
      lines.push(`${indent}${marker}${first}`)
      for (const line of rest) lines.push(`${indent}${line}`)
    }
    lines.push(`${indent}  id:: ${node.id}`)

    if (depth + 1 >= MAX_ROLLUP_DEPTH) return
    emitChildren(id, depth + 1)
  }

  const emitChildren = (id: string, depth: number) => {
    let olRun = 0
    for (const childId of childIdsOf(graph, id)) {
      const child = graph.nodes.get(childId)
      olRun = child?.type === "ol" ? olRun + 1 : 0
      emitNode(childId, depth, olRun)
    }
  }

  emitChildren(pageId, 0)
  return lines.join("\n") + "\n"
}

// -----------------------------------------------------------------------------
// Cross-file block-id dedup (unchanged from v1 — ids key the nodes table)
// -----------------------------------------------------------------------------

/** One cross-note block-id collision: the id and every note that declares it. */
export interface CrossNoteIdCollision {
  blockId: string
  /** The colliding notes, in lexicographic note-id order; by convention the
   * first entry keeps the id. */
  noteIds: NoteId[]
}

/**
 * Detect block ids declared by more than one note. `parse` regenerates
 * duplicate ids *within* one document; across documents the same persisted
 * `id::` can legitimately appear twice (e.g. a whole note duplicated in an
 * external editor). The seed script reports these — an accidental cross-note
 * share would otherwise silently become a multi-parent node.
 */
export function findCrossNoteIdCollisions(notes: Record<NoteId, string>): CrossNoteIdCollision[] {
  const owners = new Map<string, NoteId[]>()
  for (const noteId of Object.keys(notes).sort()) {
    const doc = parse(notes[noteId])
    for (const blockId of Object.keys(doc.blocks)) {
      const existing = owners.get(blockId)
      if (existing) existing.push(noteId)
      else owners.set(blockId, [noteId])
    }
  }
  return [...owners.entries()]
    .filter(([, noteIds]) => noteIds.length > 1)
    .map(([blockId, noteIds]) => ({ blockId, noteIds }))
    .sort((a, b) => (a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0))
}
