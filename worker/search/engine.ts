// Search over MCP, in the app's own query language (docs/mcp-search.md).
//
// The MCP `search` tool used to match a case-insensitive substring, which was
// a second search semantics over the one corpus — `type:todo` meant something
// in the search box and nothing to an agent. This module runs the app's own
// engine instead: `parseQuery` splits a query into STRUCTURED filters —
// `type`, `date`, `in`, `no`, `has`, property keys, `sort` — and a free-text
// remainder, and `searchBlocks` (src/utils/block-search.ts) applies them
// exactly as the app does. So `in:<note or block id>`, `type:todo,done`,
// `-type:done`, `sort:updated` mean over MCP what they mean in the app, and
// the query language is written once.
//
// A query with no free text is an ENUMERATION of whatever the filters admit
// (`type:todo` is every open to-do the grant can see), in document order;
// with free text it is the app's fuzzy match, ranked. Either way every hit is
// resolved through the grant's scoped view (graph-access.ts), so a
// note-scoped token is handed nothing outside its notes.
//
// Deliberately lexical only. A semantic half (embeddings, a vector index) was
// built and measured — it retrieves paraphrases the fuzzy matcher cannot —
// and set aside for cost and complexity; the shape here is what it would
// slot back into (a second candidate list, fused by rank).
import {
  createBlockIndexer,
  searchBlocks,
  type BlockHit,
  type BlockIndex,
} from "../../src/utils/block-search"
import type { Note, NoteId } from "../../src/schema"
import { parseQuery } from "../../src/utils/search"
import { noteOf, type ScopedGraph } from "../mcp/graph-access"

/** A block's identity across the corpus: block ids are minted per note and
 * can be pinned by an `id::` line, so the same id can legitimately appear in
 * two notes — every lookup here is note-scoped. */
const blockKey = (hit: Pick<BlockHit, "noteId" | "blockId">): string =>
  `${hit.noteId}::${hit.blockId}`

/** The block types a section starts at — the same three the registry calls
 * headings, and the same three `type:heading` matches. */
const HEADING_TYPES = new Set(["h1", "h2", "h3"])

/**
 * One hit: a block, what it says, and where it lives.
 *
 * `text` is the block's WHOLE text rather than a snippet around the match:
 * at a mean of 41 characters the whole block IS the snippet. `section` is
 * the heading the block sits under — one line, NOT an ancestor path (a block
 * is reachable by many paths in a graph; there is no single "the" path).
 */
interface SearchHit {
  id: string
  noteId: NoteId
  noteTitle: string
  type: string
  text: string
  /** The heading this block sits under, or "" at the top of a note. */
  section: string
}

export interface SearchInput {
  graph: ScopedGraph
  /** The raw query, in the app's query language (docs/query-language.md). */
  query: string
  limit: number
  /** Offset into the ranking — the server's one paging convention. */
  offset?: number
}

export interface SearchResult {
  hits: SearchHit[]
  total: number
  nextCursor: string | null
}

/**
 * The notes a grant can see, as `Note` objects — the app's own derivation
 * (`noteFromNode`), so an agent's search sees the titles a person sees.
 * O(corpus), which is what `search` has always cost and what
 * docs/mcp-server.md §4 says it costs.
 */
function buildIndex(graph: ScopedGraph): BlockIndex {
  const notes: Note[] = []
  for (const id of graph.notes()) {
    const note = noteOf(graph, id)
    if (note) notes.push(note)
  }
  return createBlockIndexer()(notes, graph.snapshot)
}

/** Hits by note-scoped key, built once per call off `index.hits`. */
function byKeyOf(index: BlockIndex): Map<string, BlockHit> {
  const byKey = new Map<string, BlockHit>()
  for (const hit of index.hits) byKey.set(blockKey(hit), hit)
  return byKey
}

/** The heading a block sits under, off its own ancestry: the nearest heading
 * ancestor. One line, or nothing — never a path. */
function sectionOf(hit: BlockHit, byKey: Map<string, BlockHit>): string {
  for (let index = hit.ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = byKey.get(blockKey({ noteId: hit.noteId, blockId: hit.ancestors[index].id }))
    if (ancestor && HEADING_TYPES.has(ancestor.type)) return ancestor.text
  }
  return ""
}

/**
 * Run one search: parse, filter and rank as the app does, then page.
 */
export function searchCorpus(input: SearchInput): SearchResult {
  const parsed = parseQuery(input.query)
  const index = buildIndex(input.graph)
  const byKey = byKeyOf(index)
  // Filtered, ranked and `sort:`ed exactly as the app does it.
  const ordered = searchBlocks(parsed, index)
  const offset = input.offset ?? 0
  const end = offset + input.limit
  return {
    hits: ordered.slice(offset, end).map((hit) => ({
      id: hit.blockId,
      noteId: hit.noteId,
      noteTitle: hit.note.displayName,
      type: hit.type,
      text: hit.text,
      section: sectionOf(hit, byKey),
    })),
    total: ordered.length,
    nextCursor: end < ordered.length ? String(end) : null,
  }
}
