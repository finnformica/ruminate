// Hybrid search: ONE implementation, two callers (docs/semantic-search.md).
//
// The MCP tool (`search`, worker/mcp/tools.ts) and the HTTP endpoint the app
// could call (`worker/handlers/search.ts`) are both thin wrappers over
// `hybridSearch`. There is no per-caller ranking, because two rankings over
// one corpus is the same mistake as two query languages over one corpus, and
// this file exists because that mistake was already made once
// (docs/mcp-search.md: "Two search semantics over one corpus is one too many").
//
// ## Engine-agnostic, like everything else here
//
// The repo's seam is pure functions over a `GraphSnapshot` plus injected
// drivers (docs/multi-tenant-design.md §10). So this module takes:
//
//   - a `ScopedGraph` — the grant's view of the corpus, already scoped;
//   - an `Embedder` and a `VectorStore`, both tiny interfaces.
//
// Nothing Cloudflare-shaped appears below. The Workers AI / Vectorize
// implementations of those two interfaces live in `vector-index.ts` and are
// the only part of this feature that knows what a binding is — which is what
// lets the tests drive the real ranker with a stub embedder.
//
// ## The division of labour
//
// `parseQuery` (src/utils/search.ts) already splits a query into STRUCTURED
// filters — `tag`, `type`, `date`, `in`, `no`, `has`, property keys, `sort` —
// and a free-text remainder. Only the remainder is a retrieval question:
//
//   - the filters run over EVERY candidate, whichever half proposed it. They
//     are not semantic, they are filters, and `tag:work` has to mean the same
//     thing whether the block was found by a fuzzy match or by a vector. There
//     is one statement of what they mean — `searchBlocks` with an empty fuzzy
//     string — and both halves are intersected with its answer.
//   - the remainder goes to BOTH halves: `searchBlocks`'s fuzzy matcher and
//     the vector index.
//
// ## Vectorize returns candidates, never answers
//
// A vector match is a note id and a chunk ordinal — no text, no metadata.
// Everything a hit contains is resolved out of the `ScopedGraph` afterwards,
// through the same `BlockIndex` the lexical half ranks over. So the note-scope
// check stays in exactly one place (graph-access.ts) and is never
// reimplemented as a vector filter: a note the grant cannot see is not in the
// index this resolves through, so its candidates evaporate rather than being
// filtered out by a rule someone has to remember to write.
//
// ## Merging: neither half dominates
//
// Reciprocal-rank fusion, which uses each half's RANK and not its score —
// there is no scale on which a cosine similarity and a fuzzy-match score are
// comparable, and every attempt to invent one is a weighting in disguise.
// Measured on a 521-block fixture of the production shape
// (`scripts/chunking-experiment.ts`): lexical alone puts a paraphrased query's
// block in the top five 0% of the time and an exactly-named one 50%; sections
// alone, 85% and 100%; fused, 85% and 100% with the exactly-named ones back at
// rank 1. The lexical half earns its place by being free, deterministic and
// exact, not by winning.

import {
  blockKey,
  createBlockIndexer,
  searchBlocks,
  sortBlockHits,
  type BlockHit,
  type BlockIndex,
} from "../../src/utils/block-search"
import type { Note, NoteId } from "../../src/schema"
import { parseQuery, type Query } from "../../src/utils/search"
import { parseChunkId, sectionChunks, type SectionChunk } from "../../src/utils/search-chunks"
import { noteOf, type ScopedGraph } from "../mcp/graph-access"

/** Turns text into vectors. One method, so a test can be a lookup table. */
export interface Embedder {
  embed(texts: readonly string[]): Promise<number[][]>
}

/**
 * The vector index for ONE tenant.
 *
 * The tenant is bound when the store is made and there is no parameter for it
 * — the same shape `TenantDb` has, and for the same reason: a caller cannot
 * name a partition it was not given (worker/search/vector-index.ts).
 */
export interface VectorStore {
  search(vector: number[], topK: number): Promise<{ id: string; score: number }[]>
  upsert(entries: { id: string; values: number[] }[]): Promise<void>
  remove(ids: string[]): Promise<void>
}

/** Both halves of the semantic side, or `null` for lexical only. */
export interface Semantic {
  embedder: Embedder
  store: VectorStore
}

/**
 * How many chunks the vector index is asked for. Vectorize caps `topK` at 100
 * without metadata and 50 with it; this index stores no metadata precisely so
 * the higher cap applies — there is nothing to store, because every field of a
 * hit is derivable from the graph.
 */
const TOP_K = 100

/**
 * The most blocks the semantic half contributes once chunks are expanded.
 *
 * A chunk is a section, so 100 chunks can be several hundred blocks, and past
 * a point a candidate nobody will read is only a filter to run. Fusion cares
 * about rank, and rank 300 never survives it.
 */
const MAX_SEMANTIC_CANDIDATES = 200

/** The RRF constant. 60 is the value the method was published with, and the
 * ranking is insensitive to it in the range that matters here. */
const RRF_K = 60

/** The block types a section chunk starts at — the same three the registry
 * calls headings, and the same three `type:heading` matches. */
const HEADING_TYPES = new Set(["h1", "h2", "h3"])

/**
 * One hit: a block, what it says, and where it lives.
 *
 * `text` is the block's WHOLE text rather than a snippet around the match,
 * which docs/mcp-search.md asked for before this corpus was measured — at a
 * mean of 41 characters the whole block IS the snippet, and cutting it would
 * spend code to save nothing. `section` is the heading the block sits under:
 * the chunk it was indexed in, one line, NOT an ancestor path.
 */
interface SearchHit {
  id: string
  noteId: NoteId
  noteTitle: string
  type: string
  text: string
  /** The heading this block sits under, or "" at the top of a note. */
  section: string
  /** Which half proposed it. */
  matchedBy: "lexical" | "semantic" | "both"
}

export interface HybridSearchInput {
  graph: ScopedGraph
  /** The raw query, in the app's query language (docs/query-language.md). */
  query: string
  limit: number
  /** Offset into the ranking — the server's one paging convention. */
  offset?: number
  /** Absent = lexical only, which is a working search, not a failure. */
  semantic?: Semantic | null
}

export interface HybridSearchResult {
  hits: SearchHit[]
  total: number
  nextCursor: string | null
  /** What each half proposed before fusion — for the operator, and so an agent
   * can tell whether the semantic half was consulted at all. */
  counts: { lexical: number; semantic: number }
  /** False without a binding, and false for a query with no free text for
   * either matcher to work on (a bare `tag:work` enumeration). */
  semanticUsed: boolean
}

/**
 * The notes a grant can see, as `Note` objects — the app's own derivation
 * (`noteFromNode`), so an agent's search sees the titles and tags a person
 * sees. O(corpus), which is what `search` has always cost and what
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

/**
 * The lookups the ranker needs, built once per call off `index.hits` — which
 * is already document order grouped by note, so this is one pass.
 *
 * Without it the obvious code is a `find` inside a loop over candidates, which
 * is O(corpus) per candidate. The corpus is small today; that is not a reason
 * to write the quadratic version.
 */
interface Lookups {
  byKey: Map<string, BlockHit>
  byNote: Map<NoteId, BlockHit[]>
}

function lookupsOf(index: BlockIndex): Lookups {
  const byKey = new Map<string, BlockHit>()
  const byNote = new Map<NoteId, BlockHit[]>()
  for (const hit of index.hits) {
    byKey.set(blockKey(hit), hit)
    const existing = byNote.get(hit.noteId)
    if (existing) existing.push(hit)
    else byNote.set(hit.noteId, [hit])
  }
  return { byKey, byNote }
}

/**
 * The semantic half: vector matches → chunk ordinals → the blocks those chunks
 * cover, in document order, best chunk first.
 *
 * The chunks are rebuilt here by the SAME pure function the indexer used
 * (`sectionChunks`) over the same document-order walk, so an ordinal names the
 * same blocks at query time as it did at index time. If the note has changed
 * since, the ordinal names whatever is there now — which is the right answer
 * for a candidate generator, and self-heals on the next sync pass.
 *
 * Every step after the vector search reads the SCOPED index, so a candidate
 * naming a note this grant cannot see resolves to nothing and disappears.
 */
async function semanticCandidates(
  semantic: Semantic,
  text: string,
  graph: ScopedGraph,
  lookups: Lookups,
): Promise<BlockHit[]> {
  const [vector] = await semantic.embedder.embed([text])
  if (!vector) return []
  const matches = await semantic.store.search(vector, TOP_K)

  const chunkCache = new Map<NoteId, SectionChunk[]>()
  const seen = new Set<string>()
  const candidates: BlockHit[] = []

  for (const match of matches) {
    const parsed = parseChunkId(match.id)
    if (!parsed) continue
    const hits = lookups.byNote.get(parsed.noteId)
    const note = noteOf(graph, parsed.noteId)
    if (!hits || !note) continue
    let chunks = chunkCache.get(parsed.noteId)
    if (!chunks) {
      chunks = sectionChunks(note.displayName, hits)
      chunkCache.set(parsed.noteId, chunks)
    }
    const chunk = chunks[parsed.ordinal]
    if (!chunk) continue
    for (const blockId of chunk.blockIds) {
      const key = blockKey({ noteId: parsed.noteId, blockId })
      const hit = lookups.byKey.get(key)
      if (!hit || seen.has(key)) continue
      seen.add(key)
      candidates.push(hit)
      if (candidates.length >= MAX_SEMANTIC_CANDIDATES) return candidates
    }
  }
  return candidates
}

/** Reciprocal-rank fusion of two rankings over the same blocks, with which
 * half proposed each one carried through. */
function fuse(lexical: BlockHit[], semantic: BlockHit[]) {
  const fused = new Map<
    string,
    { hit: BlockHit; score: number; lexical: boolean; semantic: boolean }
  >()
  const add = (hits: BlockHit[], half: "lexical" | "semantic") => {
    hits.forEach((hit, index) => {
      const key = blockKey(hit)
      const points = 1 / (RRF_K + index + 1)
      const existing = fused.get(key)
      if (existing) {
        existing.score += points
        existing[half] = true
      } else {
        fused.set(key, {
          hit,
          score: points,
          lexical: half === "lexical",
          semantic: half === "semantic",
        })
      }
    })
  }
  add(lexical, "lexical")
  add(semantic, "semantic")
  return [...fused.values()].sort((a, b) => b.score - a.score)
}

/** The heading a block sits under, off its own breadcrumb: the nearest
 * heading ancestor. One line, or nothing — never a path. */
function sectionOf(hit: BlockHit, lookups: Lookups): string {
  for (let index = hit.ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = lookups.byKey.get(
      blockKey({ noteId: hit.noteId, blockId: hit.ancestors[index].id }),
    )
    if (ancestor && HEADING_TYPES.has(ancestor.type)) return ancestor.text
  }
  return ""
}

/**
 * Run one hybrid search.
 *
 * The order of operations is the design: parse, filter, rank each half, fuse,
 * sort, page.
 */
export async function hybridSearch(input: HybridSearchInput): Promise<HybridSearchResult> {
  const parsed = parseQuery(input.query)
  const index = buildIndex(input.graph)
  const lookups = lookupsOf(index)
  const offset = input.offset ?? 0

  // Everything the structured half admits, in document order. This is also the
  // whole answer for a query with no free text (`tag:recipe`), which the query
  // language calls an enumeration rather than a search.
  const filtersOnly: Query = { filters: parsed.filters, fuzzy: "", sorts: [] }
  const allowed = searchBlocks(filtersOnly, index)

  if (parsed.fuzzy === "") {
    return pageOf({
      ordered: sortBlockHits(allowed, parsed.sorts),
      offset,
      limit: input.limit,
      lookups,
      counts: { lexical: 0, semantic: 0 },
      semanticUsed: false,
      sourceOf: () => "lexical",
    })
  }

  const admitted = new Set(allowed.map(blockKey))
  const keep = (hits: BlockHit[]) => hits.filter((hit) => admitted.has(blockKey(hit)))

  const lexical = keep(searchBlocks({ ...filtersOnly, fuzzy: parsed.fuzzy }, index))
  const semantic = input.semantic
    ? keep(await semanticCandidates(input.semantic, parsed.fuzzy, input.graph, lookups))
    : []

  const fused = fuse(lexical, semantic)
  const sources = new Map(fused.map((entry) => [blockKey(entry.hit), entry]))

  return pageOf({
    ordered: sortBlockHits(
      fused.map((entry) => entry.hit),
      parsed.sorts,
    ),
    offset,
    limit: input.limit,
    lookups,
    counts: { lexical: lexical.length, semantic: semantic.length },
    semanticUsed: Boolean(input.semantic),
    sourceOf: (hit) => {
      const entry = sources.get(blockKey(hit))
      if (!entry) return "lexical"
      return entry.lexical && entry.semantic ? "both" : entry.semantic ? "semantic" : "lexical"
    },
  })
}

/** One page of the ranking, rendered as hits. */
function pageOf(input: {
  ordered: BlockHit[]
  offset: number
  limit: number
  lookups: Lookups
  counts: { lexical: number; semantic: number }
  semanticUsed: boolean
  sourceOf: (hit: BlockHit) => SearchHit["matchedBy"]
}): HybridSearchResult {
  const end = input.offset + input.limit
  return {
    hits: input.ordered.slice(input.offset, end).map((hit) => ({
      id: hit.blockId,
      noteId: hit.noteId,
      noteTitle: hit.note.displayName,
      type: hit.type,
      text: hit.text,
      section: sectionOf(hit, input.lookups),
      matchedBy: input.sourceOf(hit),
    })),
    total: input.ordered.length,
    nextCursor: end < input.ordered.length ? String(end) : null,
    counts: input.counts,
    semanticUsed: input.semanticUsed,
  }
}
