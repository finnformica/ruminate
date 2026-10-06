import { Searcher, type FullOptions } from "fast-fuzzy"
import { searchTypeValues } from "../blocks/registry"
import type { BlockType } from "../blocks/types"
import { isCorpusRoot, isNoteType, noteDoc, parentIdsOf, type GraphSnapshot } from "../data/graph"
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
 * A hit is one OCCURRENCE: a block a note reaches by two paths (a picture
 * under two of a board's values, docs/boards.md) is two hits, each carrying
 * the path it came by (`ancestors`), so a result row can show where it was
 * found. What the block IS does not depend on the path, though, so the
 * ancestor qualifiers read the block's whole situation off either hit: its
 * direct parents in the graph (`parents`) and every ancestor on any of its
 * paths within the note (`lineage`). That is what lets `parent:a parent:b`
 * mean a block under both — the one query a path-bound test could never
 * satisfy, since no single path has two parents.
 *
 * Query semantics (all composable with the existing `parseQuery` vocabulary):
 * - `type:` filters with block-type values (the table below) match the block
 *   itself; `in:` scopes to what is downstream of a note or a block (see
 *   `testScopeFilter`); `under:` and `parent:` scope to what is beneath a
 *   block named by its text or id, across notes (`testAncestorFilter`);
 *   every other qualifier (`date:`, a property, `has:`/`no:`, …) filters by
 *   the containing note, exactly as note search does.
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
 * focus param (`/views/$noteId?block=$blockId`); `note` is the containing
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
  /** Ancestor blocks on the path this hit came by, outermost first — what
   * an `in:` scope tests, and what a result row shows as its breadcrumb. */
  ancestors: BlockAncestor[]
  /** The block's direct parents in the graph — every block holding it, in
   * this note or another, however many; the note itself is not one. What
   * `parent:` tests. For a block with one parent this is the last of
   * `ancestors`; shared between the hits of a block reached twice. */
  parents: BlockAncestor[]
  /** Every ancestor on any of the block's paths within the note — the union
   * of `ancestors` over its occurrences, in first-met order, each once. What
   * `under:` tests. For a block reached once this is `ancestors`; shared
   * between the hits of a block reached twice. */
  lineage: BlockAncestor[]
  /** The containing note — metadata for note-level qualifiers and rendering. */
  note: Note
  /** How well the block's text matched the query's text (fast-fuzzy's 0–1),
   * on a hit a text search returned; absent on a hit a bare `type:` listed.
   * The one scale the notes' title matches are scored on too, so a results
   * list can rank the two together (`rankResultRows`). */
  score?: number
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
 *
 * A block the walk reaches twice is two hits, one per path — and the two
 * share one `parents` list and one `lineage`, since those are the block's,
 * not the path's: the parents are read off the graph, and the lineage is
 * gathered over the walk, so it is complete only once the walk is, and is
 * handed to the hits at the end.
 */
export function indexNoteBlocks(note: Note, snapshot: GraphSnapshot): NoteBlockIndex {
  const doc = noteDoc(note.id, snapshot) ?? { props: null, rootBlockIds: [], blocks: {} }
  const hits: BlockHit[] = []
  let fenceOpen = false

  // Per block: its parents, read off the graph once; and the ancestors met
  // on any path to it, each once, in the order first met.
  const parents = new Map<string, BlockAncestor[]>()
  const parentsOf = (id: string): BlockAncestor[] => {
    let known = parents.get(id)
    if (!known) {
      known = []
      for (const parentId of parentIdsOf(snapshot, id)) {
        const node = snapshot.nodes.get(parentId)
        // The note holding a root block is not a parent block, and the
        // corpus root holds notes only to order them.
        if (!node || parentId === id || isNoteType(node.type) || isCorpusRoot(node)) continue
        known.push({ id: parentId, text: node.text })
      }
      parents.set(id, known)
    }
    return known
  }
  const lineages = new Map<string, Map<string, BlockAncestor>>()

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
      let lineage = lineages.get(id)
      if (!lineage) {
        lineage = new Map()
        lineages.set(id, lineage)
      }
      for (const ancestor of ancestors) {
        if (!lineage.has(ancestor.id)) lineage.set(ancestor.id, ancestor)
      }
      hits.push({
        blockId: id,
        noteId: note.id,
        text,
        type,
        ancestors,
        parents: parentsOf(id),
        lineage: [],
        note,
      })
      path.add(id)
      walk(block.children, [...ancestors, { id, text }])
      path.delete(id)
    }
  }
  walk(doc.rootBlockIds, [])

  // The lineages are whole now: one array per block, shared by its hits.
  const settled = new Map<string, BlockAncestor[]>()
  for (const hit of hits) {
    let lineage = settled.get(hit.blockId)
    if (!lineage) {
      lineage = [...(lineages.get(hit.blockId)?.values() ?? [])]
      settled.set(hit.blockId, lineage)
    }
    hit.lineage = lineage
  }

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
 * itself is not in its own scope — `in:` is "inside", the way a focused
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

/** Is this `under:` or `parent:` — an ancestor filter (`testAncestorFilter`)? */
function isAncestorFilter(filter: Filter): boolean {
  return filter.key === "under" || filter.key === "parent"
}

/** Does this query name an ancestor (`under:` / `parent:`)? Such a query
 * asks for blocks — the rows beneath a block are blocks, and a note is not
 * one — so it resolves at block granularity like a block-scoped `type:`. */
export function hasAncestorFilter(filters: Filter[]): boolean {
  return filters.some(isAncestorFilter)
}

/** Does an `under:` / `parent:` value name this ancestor — by its id, or by
 * its text: a case-insensitive substring, so `under:alice` finds the rows
 * under "Alice Smith" and under "**Alice**" alike. A scope wants precision,
 * so the text is never fuzzy-matched. */
function matchesAncestor(value: string, ancestor: BlockAncestor): boolean {
  if (value === ancestor.id) return true
  const needle = value.trim().toLowerCase()
  return needle !== "" && ancestor.text.toLowerCase().includes(needle)
}

/**
 * `under:` and `parent:` — everything beneath a block named by what it SAYS,
 * across every note. `in:` scopes to one block by id, and a block id is
 * minted per note: the "Alice" row in each day's standup is a different
 * block, so no id spans them. `under:alice` does — a row is under it when any
 * ancestor on any of its paths within the note matches (`matchesAncestor`,
 * over `hit.lineage`); `parent:alice` when any of its direct parents does
 * (`hit.parents`), which is the direct children and nothing deeper. A value
 * is matched by id too, so `parent:<block id>` is one block's direct
 * children. The ancestor itself is never a result — it is the scope, not a
 * row in it — and `-` and comma lists work as on any qualifier.
 *
 * Neither is tested against the one path the hit came by (`hit.ancestors`,
 * which is what `in:` reads): a block held by two parents is two hits, one
 * per path, and a test bound to the path would make `parent:a parent:b`
 * unsatisfiable — each hit sees one parent — when the block is plainly
 * under both. Testing the block's whole situation from either hit makes the
 * conjunction hold, while a comma list within one qualifier still ORs: so
 * `parent:a,b` is either and `parent:a parent:b` is both. A block with one
 * parent and one path is exactly as it was.
 */
function testAncestorFilter(filter: Filter, hit: BlockHit): boolean {
  const ancestors = filter.key === "parent" ? hit.parents : hit.lineage
  const match = filter.values.some((value) =>
    ancestors.some((ancestor) => matchesAncestor(value, ancestor)),
  )
  return filter.exclude ? !match : match
}

const collator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
  ignorePunctuation: true,
})

/**
 * Two block hits on a list of sort keys, left to right — the one comparator
 * behind a search's `sort:` and a note's Sort menu
 * (`src/utils/view-narrowing.ts`), so a key means the same thing in both.
 */
export function compareBlockHits(a: BlockHit, b: BlockHit, sorts: Sort[]): number {
  for (const sort of sorts) {
    let result = 0
    switch (sort.key) {
      case "text":
        result = collator.compare(a.text, b.text)
        break
      case "type":
        // Groups the to-dos together, then the headings, then the rest —
        // ordered by the stored type's name, which is the one the `type:`
        // vocabulary is built from.
        result = collator.compare(a.type, b.type)
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
 * Run a parsed query against the block index. Qualifiers AND together — a
 * key repeated (`parent:a parent:b`) is two qualifiers, both to hold — and
 * a comma list within one ORs: block-scoped `type:` filters test the block,
 * `in:` tests the block's ancestry / note (`testScopeFilter`), `under:` /
 * `parent:` test its lineage's and parents' text or id
 * (`testAncestorFilter`), everything else tests the containing note. Fuzzy text ranks by relevance over block text; without it,
 * hits keep index order (document order grouped by note). `sort:` keys:
 * `text` (block text), `updated`/`updated_at` (note fallback, see above), and
 * any note-level key (`title`, a property, …) applied via the containing
 * note.
 */
export function searchBlocks(query: Query, index: BlockIndex): BlockHit[] {
  const blockFilters = query.filters.filter(isBlockTypeFilter)
  const scopeFilters = query.filters.filter(isScopeFilter)
  const ancestorFilters = query.filters.filter(isAncestorFilter)
  const noteFilters = query.filters.filter(
    (filter) => !isBlockTypeFilter(filter) && !isScopeFilter(filter) && !isAncestorFilter(filter),
  )

  // A text search scores each hit (best first); a bare filter lists the
  // index in document order, unscored.
  const candidates = query.fuzzy
    ? index.searcher
        .search(query.fuzzy, { returnMatchData: true })
        .map((match) => ({ ...match.item, score: match.score }))
    : index.hits
  const results = candidates.filter(
    (hit) =>
      blockFilters.every((filter) => testBlockTypeFilter(filter, hit)) &&
      scopeFilters.every((filter) => testScopeFilter(filter, hit)) &&
      ancestorFilters.every((filter) => testAncestorFilter(filter, hit)) &&
      testNoteFilters(noteFilters, hit.note),
  )

  return query.sorts.length
    ? [...results].sort((a, b) => compareBlockHits(a, b, query.sorts))
    : results
}

/**
 * The notes containing a list of block hits, deduped in first-hit order —
 * what the Views page renders when a query carries a block-scoped `type:`
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
