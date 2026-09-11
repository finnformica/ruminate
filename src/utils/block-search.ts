import { Searcher, type FullOptions } from "fast-fuzzy"
import { searchTypeValues } from "../blocks/registry"
import type { BlockType } from "../blocks/types"
import { olPositions } from "../blocks/view"
import { pageDoc, type GraphSnapshot } from "../data/graph"
import type { Note, NoteId } from "../schema"
import type { Filter, Query, Sort } from "./search"
import { compareNotes, matchesNoteScope, testNoteFilters } from "./search-notes"

/**
 * Block-granular search: resolve a query to individual BLOCKS instead of
 * notes. This is the data-layer engine behind the `type:` qualifier
 * (`type:todo` = every unchecked checkbox in the corpus) and the block-results
 * UI (`src/components/search-results.tsx`). Everything runs client-side over
 * the graph — see `blockIndexAtom` / `searchBlocksAtom` in global-state.ts
 * for the derived-atom wiring.
 *
 * A hit is a ROW, not a subtree: it carries its own text and type, its
 * breadcrumb ancestry and a `childCount` presence flag, and nothing below it.
 * Children are resolved on expand through `BlockIndex.getChildren`, and
 * cached — see `createChildResolver`, which is also the seam an async
 * (server-side) source would slot into.
 *
 * Query semantics (all composable with the existing `parseQuery` vocabulary):
 * - `type:` filters with block-type values (the table below) match the block
 *   itself; `in:` scopes to what is downstream of a note or a block (see
 *   `testScopeFilter`); every other qualifier (`tag:`, `date:`, frontmatter,
 *   `has:`/`no:`, …) filters by the containing note, exactly as note search
 *   does.
 * - Fuzzy text matches the block's own text (fast-fuzzy, same threshold as
 *   note search); with fuzzy text present, results rank by fuzzy relevance,
 *   otherwise document order grouped by note (in the note order the index
 *   was built from — `sortedNotesAtom`).
 * - `-` exclusion and comma lists work on `type:` like any other qualifier.
 */

/**
 * The `type:` query vocabulary → the stored block types each value matches
 * (the registry in `src/blocks/types.ts` — one vocabulary for the query
 * language, the index and the rows that draw the results).
 *
 * | value           | matches                                  |
 * | --------------- | ---------------------------------------- |
 * | `todo`          | unchecked checkbox                       |
 * | `done`          | checked checkbox                         |
 * | `task`          | any checkbox, checked or not             |
 * | `heading`       | any heading                              |
 * | `h1`…`h3`       | that heading type                        |
 * | `list`          | bullet or ordered list item              |
 * | `bullet` / `ul` | bullet list item                         |
 * | `ordered`/ `ol` | ordered list item                        |
 * | `quote`         | quote                                    |
 * | `code`          | a code block, or a line inside a fence   |
 * | `text`          | plain paragraph                          |
 *
 * A `type:` value outside this table is NOT block vocabulary: on its own the
 * filter stays a note-type filter (`type:daily` — see
 * search-notes.ts), unchanged from before. Mixed into a block-scoped comma
 * list (`type:todo,zzz`) an unknown value simply matches no blocks.
 */
const BLOCK_TYPE_VALUES: Record<string, readonly BlockType[]> = searchTypeValues()

/** Is this a `type:` filter carrying at least one block-type value? Such a
 * filter matches blocks; any other filter (including `type:daily`) keeps its
 * note-level meaning. */
export function isBlockTypeFilter(filter: Filter): boolean {
  return filter.key === "type" && filter.values.some((value) => value in BLOCK_TYPE_VALUES)
}

/** Does this query resolve to blocks? (At least one block-scoped `type:`.) */
export function hasBlockTypeFilter(filters: Filter[]): boolean {
  return filters.some(isBlockTypeFilter)
}

/** One ancestor block on a hit's breadcrumb trail. */
export interface BlockAncestor {
  id: string
  /** Display text. */
  text: string
}

/**
 * One block-level search result. Carries exactly what a results ROW needs to
 * render and navigate, and nothing downstream: the target is the note route
 * with the `?block=` zoom param (`/notes/$noteId?block=$blockId`), the
 * breadcrumb is `ancestors`, and `note` is the containing note's metadata.
 *
 * Children are deliberately NOT embedded — `childCount` is the presence flag
 * the UI draws its expand chevron from, and the children themselves are
 * resolved on expand through `BlockIndex.getChildren` (memoized). See the
 * "Lazy children" note below.
 */
export interface BlockHit {
  blockId: string
  noteId: NoteId
  /** The block's own text. */
  text: string
  /** The block's stored type (a line inside a code fence reads as `code`). */
  type: BlockType
  /** An ordered item's number in its run of ordered siblings (1 otherwise) —
   * a fact of its position in the note, carried so the row shows it. */
  olNumber: number
  /** Ancestor blocks, outermost first (ids + display texts, for breadcrumbs). */
  ancestors: BlockAncestor[]
  /**
   * How many direct children the block has — the has-downstream flag. `> 0`
   * means the row draws an expand affordance; the children themselves are
   * fetched only when it's used.
   */
  childCount: number
  /** The containing note — metadata for note-level qualifiers and rendering. */
  note: Note
}

/**
 * A block's identity across the whole corpus. Block ids are minted per note
 * and can be *pinned* by an `id::` line, so the same id can legitimately
 * appear in two notes — every corpus-wide lookup is note-scoped.
 */
export function blockKey(hit: Pick<BlockHit, "noteId" | "blockId">): string {
  return `${hit.noteId}::${hit.blockId}`
}

// ── Lazy children ───────────────────────────────────────────────────────────

/**
 * Resolves a hit's direct children, in document order. Empty for a leaf.
 *
 * This engine is in-memory and therefore synchronous. The *seam* an async
 * (server-backed) implementation drops into is `BlockSearchSource` in
 * `block-search-source.ts`, whose `children` is await-tolerant; this type is
 * just what the in-memory index supplies to it.
 */
type BlockChildResolver = (hit: BlockHit) => BlockHit[]

/**
 * Memoize a child resolver, per block (note-scoped id — see `blockKey`).
 * Expanding a block twice does the work once; expanding one of its children
 * resolves the next level the same way, through the same cache.
 *
 * Generic in the resolved value on purpose: an async source memoizes its
 * *promises* through this same function, so a second expand of the same block
 * never re-queries and the cache key stays identical across both worlds.
 */
export function createChildResolver<T>(source: (hit: BlockHit) => T): (hit: BlockHit) => T {
  const cache = new Map<string, T>()
  return (hit) => {
    const key = blockKey(hit)
    if (cache.has(key)) return cache.get(key) as T
    const children = source(hit)
    cache.set(key, children)
    return children
  }
}

/** One note's blocks: its hits in document order, plus the parent →
 * child-ids edges the lazy resolver walks (ids only — no block payload). */
export interface NoteBlockIndex {
  hits: BlockHit[]
  /** Child ids by parent block id, for blocks that have any. */
  childIds: Map<string, string[]>
}

/** The type a hit reports: the stored type, except that a line inside a
 * code fence (or a fence delimiter) is code whatever it is. */
function hitType(type: BlockType, text: string, inFence: boolean): BlockType {
  if (inFence || text.trimStart().startsWith("```")) return "code"
  return type
}

/**
 * Walk one note's page into its block hits, in document order (the
 * depth-first walk the serializer emits — which is also how the fence state
 * must be tracked), plus the parent → child-ids edges. This is the per-note
 * step the indexer memoizes.
 */
export function indexNoteBlocks(note: Note, snapshot: GraphSnapshot): NoteBlockIndex {
  const doc = pageDoc(note.id, snapshot) ?? { props: null, rootBlockIds: [], blocks: {} }
  const hits: BlockHit[] = []
  const childIds = new Map<string, string[]>()
  let fenceOpen = false

  const walk = (ids: string[], ancestors: BlockAncestor[]) => {
    const numbers = olPositions(doc, ids)
    ids.forEach((id, index) => {
      const block = doc.blocks[id]
      if (!block) return
      const inFence = fenceOpen
      if (block.text.trimStart().startsWith("```")) fenceOpen = !fenceOpen
      const type = hitType(block.type, block.text, inFence)
      const text = block.text
      hits.push({
        blockId: id,
        noteId: note.id,
        text,
        type,
        olNumber: numbers[index] || 1,
        ancestors,
        childCount: block.children.length,
        note,
      })
      if (block.children.length > 0) childIds.set(id, block.children)
      walk(block.children, [...ancestors, { id, text }])
    })
  }
  walk(doc.rootBlockIds, [])

  return { hits, childIds }
}

/**
 * The corpus-wide block index. Both the fuzzy `searcher` and the lookup tables
 * `getChildren` walks are built lazily on first access, so a corpus change
 * never pays for indexing that no query — and no expand — asked for.
 */
export interface BlockIndex {
  /** Every block hit, in document order grouped by note (input note order). */
  hits: BlockHit[]
  readonly searcher: Searcher<BlockHit, FullOptions<BlockHit>>
  /** A hit's direct children in document order, memoized per block. */
  getChildren: BlockChildResolver
  /**
   * Look a block up by id alone — the first note (in index order) carrying
   * it. For describing an `in:` scope to a human (a block id names a
   * subtree, but the reader wants to see its text); a block shared across
   * notes resolves to the same text wherever it lives, so "first" is fine.
   */
  getBlock: (blockId: string) => BlockHit | undefined
}

/**
 * A memoizing index builder: call the returned function with the current note
 * list and the graph, and only notes whose `Note` changed are re-walked — a
 * `Note` object is kept as long as the rows its page reaches are unchanged
 * (`createNotesBuilder`), so an untouched note reuses its block entries.
 * Notes that disappear are evicted.
 */
export function createBlockIndexer(
  indexNote: (note: Note, snapshot: GraphSnapshot) => NoteBlockIndex = indexNoteBlocks,
) {
  const cache = new Map<NoteId, { note: Note; blocks: NoteBlockIndex }>()

  return function buildIndex(notes: Note[], snapshot: GraphSnapshot): BlockIndex {
    const seen = new Set<NoteId>()
    const all: BlockHit[] = []
    // Per-note edge tables, referenced (never copied) from the memo.
    const edges = new Map<NoteId, Map<string, string[]>>()

    for (const note of notes) {
      seen.add(note.id)
      let cached = cache.get(note.id)
      if (!cached || cached.note !== note) {
        cached = { note, blocks: indexNote(note, snapshot) }
        cache.set(note.id, cached)
      }
      for (const hit of cached.blocks.hits) all.push(hit)
      edges.set(note.id, cached.blocks.childIds)
    }

    for (const id of cache.keys()) {
      if (!seen.has(id)) cache.delete(id)
    }

    let searcher: Searcher<BlockHit, FullOptions<BlockHit>> | null = null
    let byKey: Map<string, BlockHit> | null = null
    const lookup = () => (byKey ??= new Map(all.map((hit) => [blockKey(hit), hit])))
    let byBlockId: Map<string, BlockHit> | null = null
    const lookupById = () => {
      if (byBlockId) return byBlockId
      byBlockId = new Map()
      for (const hit of all) if (!byBlockId.has(hit.blockId)) byBlockId.set(hit.blockId, hit)
      return byBlockId
    }

    return {
      hits: all,
      get searcher() {
        searcher ??= new Searcher(all, { keySelector: (hit) => hit.text, threshold: 0.8 })
        return searcher
      },
      getChildren: createChildResolver((hit) => {
        const ids = edges.get(hit.noteId)?.get(hit.blockId)
        if (!ids || ids.length === 0) return []
        const blocks = lookup()
        return ids
          .map((id) => blocks.get(blockKey({ noteId: hit.noteId, blockId: id })))
          .filter((child): child is BlockHit => child !== undefined)
      }),
      getBlock: (blockId) => lookupById().get(blockId),
    }
  }
}

function testBlockTypeFilter(filter: Filter, hit: BlockHit): boolean {
  const match = filter.values.some((value) => BLOCK_TYPE_VALUES[value]?.includes(hit.type) ?? false)
  return filter.exclude ? !match : match
}

/** Is this the `in:` qualifier — the scope filter (see `testScopeFilter`)? */
function isScopeFilter(filter: Filter): boolean {
  return filter.key === "in"
}

/**
 * `in:` — everything DOWNSTREAM of a note or a block: reachability from the
 * scope, read off the row's own ancestry. A value names either a note (by
 * id, or by its name, case-insensitively — `in:"Reading list"`) or a block
 * (by id): a row is in scope when it lives in that note, or when that block
 * is on its path from the page — so a block reachable by two paths is in
 * scope through the one that passes the scope block. The scoping block
 * itself is not in its own scope — `in:` is "inside", the way a zoomed
 * view's title is not one of the page's blocks. `-in:` excludes, comma lists
 * OR, like any qualifier.
 *
 * The same `in:` on a NOTE query (`src/utils/search-notes.ts`) matches the
 * note by id or name; a block-id scope only means something at block
 * granularity.
 */
function testScopeFilter(filter: Filter, hit: BlockHit): boolean {
  const match = filter.values.some(
    (value) =>
      matchesNoteScope(value, hit.note) || hit.ancestors.some((ancestor) => ancestor.id === value),
  )
  return filter.exclude ? !match : match
}

const collator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
  ignorePunctuation: true,
})

function compareBlockHits(a: BlockHit, b: BlockHit, sorts: Sort[]): number {
  for (const sort of sorts) {
    let result = 0
    switch (sort.key) {
      case "text":
        result = collator.compare(a.text, b.text)
        break
      case "updated":
      case "updated_at":
        // Per-block updated_at lives in the SQL store, which is async — not
        // cheaply reachable from these synchronous atoms — so blocks sort by
        // their note's updated_at (null treated as infinitely old).
        result = (a.note.updatedAt ?? -Infinity) - (b.note.updatedAt ?? -Infinity)
        break
      default: {
        // Any other key is a note-level sort, delegated to the note comparator
        // (which applies direction itself).
        const noteResult = compareNotes(a.note, b.note, [sort])
        if (noteResult !== 0) return noteResult
        continue
      }
    }
    if (result !== 0) return sort.direction === "desc" ? -result : result
  }
  return 0
}

/**
 * Run a parsed query against the block index. Qualifiers AND together:
 * block-scoped `type:` filters test the block, `in:` tests the block's
 * ancestry / note (`testScopeFilter`), everything else tests the containing
 * note. Fuzzy text ranks by relevance over block text; without it,
 * hits keep index order (document order grouped by note). `sort:` keys:
 * `text` (block text), `updated`/`updated_at` (note fallback, see above), and
 * any note-level key (`title`, frontmatter, …) applied via the containing
 * note.
 */
export function searchBlocks(query: Query, index: BlockIndex): BlockHit[] {
  const blockFilters = query.filters.filter(isBlockTypeFilter)
  const scopeFilters = query.filters.filter(isScopeFilter)
  const noteFilters = query.filters.filter(
    (filter) => !isBlockTypeFilter(filter) && !isScopeFilter(filter),
  )

  const candidates = query.fuzzy ? index.searcher.search(query.fuzzy) : index.hits
  const results = candidates.filter(
    (hit) =>
      blockFilters.every((filter) => testBlockTypeFilter(filter, hit)) &&
      scopeFilters.every((filter) => testScopeFilter(filter, hit)) &&
      testNoteFilters(noteFilters, hit.note),
  )

  return query.sorts.length
    ? [...results].sort((a, b) => compareBlockHits(a, b, query.sorts))
    : results
}

/**
 * The notes containing a list of block hits, deduped in first-hit order —
 * what the notes list renders when a query carries a block-scoped `type:`
 * (per-note hits stay available by grouping on `noteId`).
 */
export function notesFromBlockHits(hits: BlockHit[]): Note[] {
  const seen = new Set<NoteId>()
  const notes: Note[] = []
  for (const hit of hits) {
    if (seen.has(hit.noteId)) continue
    seen.add(hit.noteId)
    notes.push(hit.note)
  }
  return notes
}
