import { Searcher, type FullOptions } from "fast-fuzzy"
import { searchTypeValues } from "../blocks/registry"
import type { BlockType } from "../blocks/types"
import { noteDoc, type GraphSnapshot } from "../data/graph"
import type { Note, NoteId } from "../schema"
import type { Filter, Query, Sort } from "./search"
import { compareNotes, matchesNoteScope, testNoteFilters } from "./search-notes"

/**
 * Block-granular search: resolve a query to individual BLOCKS instead of
 * notes. This is the data-layer engine behind the `type:` qualifier
 * (`type:todo` = every unchecked checkbox in the corpus) and the results
 * views (`src/components/results-editor.tsx`, which draw a hit's block out
 * of the graph). Everything runs client-side over the graph — see
 * `blockIndexAtom` / `searchBlocksAtom` in global-state.ts for the
 * derived-atom wiring.
 *
 * A hit is a MATCH, not a subtree: the block's id and note, its own text and
 * type (what the query is tested against), and its ancestry (what an `in:`
 * scope is tested against). Nothing below it: a results view walks the
 * block's children out of the graph when a row is opened.
 *
 * Query semantics (all composable with the existing `parseQuery` vocabulary):
 * - `type:` filters with block-type values (the table below) match the block
 *   itself; `in:` scopes to what is downstream of a note or a block (see
 *   `testScopeFilter`); every other qualifier (`tag:`, `date:`, a property,
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
 * One block-level search result: which block, in which note, and what the
 * query is tested against. The target is the note route with the `?block=`
 * zoom param (`/notes/$noteId?block=$blockId`); `note` is the containing
 * note's metadata (note-level qualifiers). Block ids are minted per note and
 * can be *pinned* by an `id::` line, so the same id can legitimately appear
 * in two notes — a hit is always note-scoped.
 */
export interface BlockHit {
  blockId: string
  noteId: NoteId
  /** The block's own text. */
  text: string
  /** The block's stored type (a line inside a code fence reads as `code`). */
  type: BlockType
  /** Ancestor blocks, outermost first — what an `in:` scope tests. */
  ancestors: BlockAncestor[]
  /** The containing note — metadata for note-level qualifiers and rendering. */
  note: Note
}

/** One note's blocks: its hits in document order. */
export interface NoteBlockIndex {
  hits: BlockHit[]
}

/** The type a hit reports: the stored type, except that a line inside a
 * code fence (or a fence delimiter) is code whatever it is. */
function hitType(type: BlockType, text: string, inFence: boolean): BlockType {
  if (inFence || text.trimStart().startsWith("```")) return "code"
  return type
}

/**
 * Walk one note's doc into its block hits, in document order (the
 * depth-first walk the serializer emits — which is also how the fence state
 * must be tracked). This is the per-note step the indexer memoizes.
 */
export function indexNoteBlocks(note: Note, snapshot: GraphSnapshot): NoteBlockIndex {
  const doc = noteDoc(note.id, snapshot) ?? { props: null, rootBlockIds: [], blocks: {} }
  const hits: BlockHit[] = []
  let fenceOpen = false

  const path = new Set<string>()
  const walk = (ids: string[], ancestors: BlockAncestor[]) => {
    for (const id of ids) {
      const block = doc.blocks[id]
      // A loop's closing occurrence is indexed once, where it closes.
      if (!block || path.has(id)) continue
      const inFence = fenceOpen
      if (block.text.trimStart().startsWith("```")) fenceOpen = !fenceOpen
      const type = hitType(block.type, block.text, inFence)
      const text = block.text
      hits.push({ blockId: id, noteId: note.id, text, type, ancestors, note })
      path.add(id)
      walk(block.children, [...ancestors, { id, text }])
      path.delete(id)
    }
  }
  walk(doc.rootBlockIds, [])

  return { hits }
}

/**
 * The corpus-wide block index. The fuzzy `searcher` and the id lookup are
 * built lazily on first access, so a corpus change never pays for indexing
 * that no query asked for.
 */
export interface BlockIndex {
  /** Every block hit, in document order grouped by note (input note order). */
  hits: BlockHit[]
  readonly searcher: Searcher<BlockHit, FullOptions<BlockHit>>
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
 * `Note` object is kept as long as the rows the note reaches are unchanged
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

    for (const note of notes) {
      seen.add(note.id)
      let cached = cache.get(note.id)
      if (!cached || cached.note !== note) {
        cached = { note, blocks: indexNote(note, snapshot) }
        cache.set(note.id, cached)
      }
      for (const hit of cached.blocks.hits) all.push(hit)
    }

    for (const id of cache.keys()) {
      if (!seen.has(id)) cache.delete(id)
    }

    let searcher: Searcher<BlockHit, FullOptions<BlockHit>> | null = null
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
 * is on its path from the note — so a block reachable by two paths is in
 * scope through the one that passes the scope block. The scoping block
 * itself is not in its own scope — `in:` is "inside", the way a zoomed
 * view's title is not one of the note's blocks. `-in:` excludes, comma lists
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
 * any note-level key (`title`, a property, …) applied via the containing
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
